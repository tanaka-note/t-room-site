import { b64,encode,validateEnvelope } from './crypto.mjs';
import { canRead } from './policy.mjs';
import { readRollout,writeLease } from './rollout.mjs';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const HOUR=3_600_000;
async function upload(env,actor,id) {
  if(!uuid(id))fail(400,'InvalidUploadId');
  const row=await env.DB.prepare('SELECT * FROM diary_e2ee_uploads WHERE id=? AND household=? AND account_id=?').bind(id,actor.activeHouseholdId,actor.accountId).first();
  if(!row)fail(404,'UploadNotFound');return row;
}
async function referenced(env,id,actor=null) {
  const rows=(await env.DB.prepare(`SELECT r.household,r.state,r.author,r.retained_for FROM diary_e2ee_records r,json_each(r.photo_ids) p WHERE p.value=?`).bind(id).all()).results;
  return actor?rows.some(row=>canRead(actor,{...row,retainedFor:JSON.parse(row.retained_for)})):rows.length>0;
}
function manage(actor){if(!actor.canManageEntries)fail(403,'AccessDenied');}

export async function retireMedia(env,actor,id,{stage=false}={}) {
  manage(actor);const lease=await writeLease(env.DB);
  const row=await env.DB.prepare('SELECT * FROM diary_e2ee_media WHERE id=? AND household=?').bind(id,actor.activeHouseholdId).first();
  if(!row)fail(404,'PhotoNotFound');
  if(await referenced(env,id))return {ok:true,preserved:true};
  const queued=await env.DB.prepare('SELECT photo_id FROM diary_e2ee_media_gc WHERE photo_id=?').bind(id).first();
  if(!queued&&!(stage&&row.account_id===actor.accountId&&row.status!=='attached'))fail(409,'PhotoRetirementNotAuthorized');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO diary_e2ee_media_gc VALUES(?,?,?) ON CONFLICT DO NOTHING`).bind(id,row.household,crypto.randomUUID()),
    env.DB.prepare(`UPDATE diary_e2ee_media SET status='retiring' WHERE id=? AND (SELECT generation FROM diary_e2ee_control WHERE id=1)=? AND NOT EXISTS(SELECT 1 FROM diary_e2ee_records r,json_each(r.photo_ids) p WHERE p.value=?)`).bind(id,lease.generation,id)
  ]);
  const marked=await env.DB.prepare('SELECT status FROM diary_e2ee_media WHERE id=?').bind(id).first();if(marked.status!=='retiring')fail(409,'PhotoRetirementConflict');
  await deleteObjects(env,row);return {ok:true};
}
async function deleteObjects(env,row) {
  if((await readRollout(env.DB)).phase!=='encrypted')fail(423,'DiaryWritesPaused');
  if(await referenced(env,row.id))fail(409,'PhotoStillReferenced');
  const results=await Promise.allSettled([...new Set([row.original_key,row.display_key,row.thumbnail_key])].map(key=>env.MEDIA.delete(key)));
  if(results.some(r=>r.status==='rejected'))fail(503,'MediaCleanupPending');
  // Retain the tombstone; retry after the maximum upload lease so late writes
  // cannot turn a cancelled upload into a permanent, untracked R2 orphan.
  if(Date.now()>row.expires_at+HOUR)await env.DB.prepare("UPDATE diary_e2ee_media SET retired_at=? WHERE id=? AND status='retiring'").bind(Date.now(),row.id).run();
}
export async function drainEncryptedMedia(env,{limit=50}={}) {
  if((await readRollout(env.DB)).phase!=='encrypted')return {processed:0};
  await env.DB.batch([
    env.DB.prepare("UPDATE diary_e2ee_media SET status='retiring' WHERE status IN ('uploading','ready') AND expires_at<? AND NOT EXISTS(SELECT 1 FROM diary_e2ee_records r,json_each(r.photo_ids) p WHERE p.value=diary_e2ee_media.id)").bind(Date.now()),
    env.DB.prepare("INSERT INTO diary_e2ee_media_gc SELECT id,household,session_id FROM diary_e2ee_media WHERE status='retiring' ON CONFLICT DO NOTHING"),
    env.DB.prepare("UPDATE diary_e2ee_uploads SET status='retiring' WHERE status='active' AND expires_at<?").bind(Date.now())
  ]);
  const rows=(await env.DB.prepare(`SELECT m.* FROM diary_e2ee_media m JOIN diary_e2ee_media_gc q ON q.photo_id=m.id WHERE m.retired_at IS NULL ORDER BY m.expires_at,m.id LIMIT ?`).bind(Math.min(50,Math.max(1,limit))).all()).results;
  let processed=0;for(const row of rows){if(await referenced(env,row.id))continue;await env.DB.prepare("UPDATE diary_e2ee_media SET status='retiring' WHERE id=?").bind(row.id).run();await deleteObjects(env,row);processed++;}return {processed};
}

export async function handleEncryptedMedia(request,env,url,path,actor,{json,readJson,readMultipartForm,store}) {
  const root='/api/encryption/uploads',method=request.method;
  const asset=path.match(/^\/api\/photos\/([0-9a-f-]{36})\/(original|display|thumbnail)$/);
  if(asset&&method==='GET') {
    const row=await env.DB.prepare('SELECT * FROM diary_e2ee_media WHERE id=? AND household=?').bind(asset[1],actor.activeHouseholdId).first();
    if(!row||row.status==='retiring'||!await referenced(env,row.id,actor))fail(404,'PhotoNotFound');
    const object=await env.MEDIA.get(row[`${asset[2]}_key`]);if(!object)fail(404,'PhotoNotFound');
    return new Response(object.body,{headers:{'Content-Type':asset[2]==='original'?'application/octet-stream':'image/webp','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  const retiring=path.match(/^\/api\/encryption\/media\/([0-9a-f-]{36})$/);
  if(retiring&&method==='DELETE')return json(await retireMedia(env,actor,retiring[1]));
  if(!path.startsWith(root))return null;
  manage(actor);
  if(path===root&&method==='POST') {
    const lease=await writeLease(env.DB),body=await readJson(request,4096),target=body.targetEntryId?await store.get(String(body.targetEntryId)):null;
    if(body.targetEntryId&&(!target||target.household!==actor.activeHouseholdId||!['published','draft'].includes(target.state)||!canRead(actor,target)))fail(403,'InvalidUploadTarget');
    const id=crypto.randomUUID();const saved=await env.DB.prepare(`INSERT INTO diary_e2ee_uploads(id,household,account_id,target_id,status,expires_at) SELECT ?,?,?,?,'active',? WHERE (SELECT generation FROM diary_e2ee_control WHERE id=1)=?`).bind(id,actor.activeHouseholdId,actor.accountId,target?.id||null,Date.now()+24*HOUR,lease.generation).run();
    if(saved.meta.changes!==1)fail(423,'DiaryWritesPaused');return json({uploadSession:{id}});
  }
  const match=path.match(/^\/api\/encryption\/uploads\/([0-9a-f-]{36})(?:\/(photos)(?:\/([0-9a-f-]{36}))?|\/(commit))?$/);
  if(!match)fail(404,'UnknownUploadRoute');
  const current=await upload(env,actor,match[1]);
  if(method==='GET'&&match[3]) {
    const row=await env.DB.prepare('SELECT id,status,metadata,epoch FROM diary_e2ee_media WHERE id=? AND session_id=? AND household=? AND account_id=?').bind(match[3],current.id,actor.activeHouseholdId,actor.accountId).first();
    if(!row||!['ready','attached'].includes(row.status))fail(404,'PhotoNotReady');return json({photo:{id:row.id},metadata:JSON.parse(row.metadata),epoch:row.epoch});
  }
  const lease=await writeLease(env.DB);
  if(method==='POST'&&match[4]) {
    const body=await readJson(request,100000),ids=body.photoIds;
    if(!Array.isArray(ids)||ids.length>5000||ids.some(id=>!uuid(id))||new Set(ids).size!==ids.length)fail(400,'InvalidPhotoIds');
    if(current.status==='committed'){if(current.committed_entry!==String(body.entryId)||current.committed_ids!==JSON.stringify(ids))fail(409,'UploadCommitConflict');return json({ok:true});}
    const entry=await store.get(String(body.entryId));if(!entry||entry.household!==actor.activeHouseholdId||!canRead(actor,entry)||ids.some(id=>!entry.photoIds.includes(id)))fail(409,'PhotoAttachmentRequired');
    const rows=(await env.DB.prepare(`SELECT id,status FROM diary_e2ee_media WHERE session_id=? AND account_id=? AND id IN (SELECT value FROM json_each(?))`).bind(current.id,actor.accountId,JSON.stringify(ids)).all()).results;
    if(rows.length!==ids.length||rows.some(row=>row.status!=='attached'))fail(409,'PhotoAttachmentRequired');
    const result=await env.DB.prepare(`UPDATE diary_e2ee_uploads SET status='committed',committed_entry=?,committed_ids=? WHERE id=? AND status='active' AND (SELECT generation FROM diary_e2ee_control WHERE id=1)=?`).bind(entry.id,JSON.stringify(ids),current.id,lease.generation).run();if(!result.meta.changes)fail(409,'UploadCommitConflict');return json({ok:true});
  }
  if(method==='DELETE') {
    const rows=(await env.DB.prepare(`SELECT id FROM diary_e2ee_media WHERE session_id=? AND status IN ('uploading','ready','retiring') ${match[3]?'AND id=?':''}`).bind(current.id,...(match[3]?[match[3]]:[])).all()).results;
    for(const row of rows)await retireMedia(env,actor,row.id,{stage:true});
    if(!match[3])await env.DB.prepare("UPDATE diary_e2ee_uploads SET status='retiring' WHERE id=? AND status='active'").bind(current.id).run();return json({ok:true});
  }
  if(method!=='POST'||!match[2]||match[3])fail(405,'MethodNotAllowed');
  if(current.status!=='active'||current.expires_at<=Date.now())fail(409,'UploadExpired');
  const form=await readMultipartForm(request,80*1024*1024);
  if([...form.keys()].some(k=>!['id','epoch','metadata','original','display','thumbnail'].includes(k)))fail(400,'PlaintextMetadataRejected');
  const encoded=form.get('metadata');if(typeof encoded!=='string'||encoded.length>20000)fail(400,'InvalidMetadata');
  let metadata;try{metadata=JSON.parse(encoded);}catch{fail(400,'InvalidMetadata');}
  const id=form.get('id'),epoch=Number(form.get('epoch'));
  if(!uuid(id)||!Number.isSafeInteger(epoch)||epoch<1)fail(400,'InvalidPhoto');validateEnvelope(metadata);
  const sizes={};for(const kind of ['original','display','thumbnail']){const file=form.get(kind);if(!(file instanceof Blob)||file.type!=='application/octet-stream'||file.name!==`${kind}.bin`||file.size<1||file.size>(kind==='original'?64:kind==='display'?8:2)*1024*1024)fail(400,'InvalidPhotoPart');sizes[kind]=file.size;}
  const hash=b64(await crypto.subtle.digest('SHA-256',encode({id,epoch,metadata,sizes}))),prefix=`diary/encrypted-staging/${actor.activeHouseholdId}/${current.id}/${id}`;
  await env.DB.prepare(`INSERT INTO diary_e2ee_media(id,household,account_id,session_id,status,original_key,display_key,thumbnail_key,metadata,epoch,request_hash,expires_at) SELECT ?,?,?,?,'uploading',?,?,?,?,?,?,? WHERE (SELECT generation FROM diary_e2ee_control WHERE id=1)=? ON CONFLICT DO NOTHING`).bind(id,actor.activeHouseholdId,actor.accountId,current.id,`${prefix}/original`,`${prefix}/display`,`${prefix}/thumbnail`,JSON.stringify(metadata),epoch,hash,current.expires_at,lease.generation).run();
  const row=await env.DB.prepare('SELECT * FROM diary_e2ee_media WHERE id=?').bind(id).first();
  if(!row||row.session_id!==current.id||row.account_id!==actor.accountId||row.request_hash!==hash||row.status==='retiring')fail(409,'PhotoUploadConflict');
  if(!['ready','attached'].includes(row.status)) {
    const writes=await Promise.allSettled(['original','display','thumbnail'].map(kind=>env.MEDIA.put(row[`${kind}_key`],form.get(kind).stream(),{httpMetadata:{contentType:'application/octet-stream'}})));
    if(writes.some(write=>write.status==='rejected'))fail(503,'PhotoUploadIncomplete');
    const result=await env.DB.prepare(`UPDATE diary_e2ee_media SET status='ready' WHERE id=? AND status='uploading' AND (SELECT generation FROM diary_e2ee_control WHERE id=1)=? AND EXISTS(SELECT 1 FROM diary_e2ee_uploads WHERE id=? AND status='active' AND expires_at>?)`).bind(id,lease.generation,current.id,Date.now()).run();
    if(!result.meta.changes){const saved=await env.DB.prepare('SELECT status FROM diary_e2ee_media WHERE id=?').bind(id).first();if(!['ready','attached'].includes(saved?.status))fail(409,'PhotoUploadConflict');}
  }
  return json({photo:{id},metadata,epoch});
}
