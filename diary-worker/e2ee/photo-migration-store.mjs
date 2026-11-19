import { b64, encode, unb64, validateEnvelope, verifySigned } from './crypto.mjs';
import { bindingOf, verifyRecord } from './record.mjs';
import { parseRecord } from './store.mjs';
import { readRollout } from './rollout.mjs';
import { PHOTO_OVERHEAD, PHOTO_PREFIX, photoHeader } from './photo-crypto.mjs';
import { createEncryptionCheckpoint, readEncryptionCheckpoint } from './checkpoint.mjs';

const kinds = ['original', 'display', 'thumbnail'];
const limits = {original:64, display:8, thumbnail:2};
const leaseMs = 120_000;
export const PHOTO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const equal = (left,right) => b64(encode(left)) === b64(encode(right));
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status}); };
const oldPhoto = `m.status='attached' AND (m.original_key NOT LIKE '${PHOTO_PREFIX}%' OR m.display_key NOT LIKE '${PHOTO_PREFIX}%' OR m.thumbnail_key NOT LIKE '${PHOTO_PREFIX}%')`;
const affected = `EXISTS(SELECT 1 FROM json_each(r.photo_ids) p JOIN diary_photo_migration_items i ON i.id=p.value JOIN diary_e2ee_media m ON m.id=i.id WHERE ${oldPhoto})`;
// An editing draft also needs a new binding if its source revision advances.
const affectedDraft = `EXISTS(SELECT 1 FROM diary_e2ee_records parent, json_each(parent.photo_ids) p JOIN diary_photo_migration_items i ON i.id=p.value JOIN diary_e2ee_media m ON m.id=i.id WHERE parent.id=r.source_id AND parent.household=r.household AND parent.revision=r.source_revision AND ${oldPhoto})`;
const needsRecord = `(${affected} OR ${affectedDraft})`;

const jobOf = db => db.prepare('SELECT * FROM diary_photo_migration_job WHERE id=1').first();
const sequenceOf = async db => (await db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM diary_e2ee_changes').first()).seq;
const publicJob = job => job ? {run:job.run,phase:job.phase,sequence:job.sequence,retainedUntil:job.retained_until} : {phase:'idle'};
const targetKey = (job,row,kind) => `${PHOTO_PREFIX}migration/${job.run}/${row.household}/${row.id}/${kind}`;

async function snapshot(env,job,lease) {
  const households = ['tanaka-household','chiharu-household'];
  if(['checking','done'].includes(job?.phase)) {
    const {results} = await env.DB.prepare(`SELECT m.household,COUNT(*) AS total FROM diary_e2ee_media m
      JOIN diary_photo_migration_items i ON i.id=m.id WHERE i.verified=7 AND m.original_key LIKE ? GROUP BY m.household`)
      .bind(`${PHOTO_PREFIX}migration/${job.run}/%`).all();
    return {...publicJob(job), house:households.map(id=>({id,total:results.find(row=>row.household===id)?.total||0,verified:results.find(row=>row.household===id)?.total||0}))};
  }
  const {results} = await env.DB.prepare(`SELECT m.household,COUNT(*) AS total, SUM(CASE WHEN i.verified=7 THEN 1 ELSE 0 END) AS verified
    FROM diary_e2ee_media m LEFT JOIN diary_photo_migration_items i ON i.id=m.id WHERE ${oldPhoto} GROUP BY m.household`).all();
  return {...publicJob(job),locked:Boolean(job?.lease && job.lease!==lease && job.lease_until>Date.now()),house:households.map(id=>({id,total:results.find(row=>row.household===id)?.total||0,verified:results.find(row=>row.household===id)?.verified||0}))};
}

function assertJob(job,directory,control,lease) {
  if(!job||job.phase==='done'||job.directory_generation!==directory.generation||job.control_generation!==control.generation)
    fail('PhotoMigrationGenerationChanged');
  if(job.phase==='checking' ? control.phase!=='paused'||control.evidence?.photoMigration!==job.run : control.phase!=='encrypted')
    fail('PhotoMigrationGenerationChanged');
  if(job.lease!==lease||job.lease_until<=Date.now())fail('PhotoMigrationLeaseLost');
}

async function migrationPhoto(db,id) {
  const row = await db.prepare(`SELECT m.* FROM diary_e2ee_media m WHERE m.id=? AND ${oldPhoto}`).bind(id).first();
  if(!row)fail('PhotoSourceChanged');
  if(!['tanaka-household','chiharu-household'].includes(row.household))fail('PhotoMigrationHouseholdChanged');
  const item = await db.prepare('SELECT * FROM diary_photo_migration_items WHERE id=?').bind(id).first();
  if(item&&!equal(row,JSON.parse(item.source)))fail('PhotoSourceChanged');
  return {row,item:item&&{...item,parts:JSON.parse(item.parts),metadata:JSON.parse(item.metadata)}};
}

function matchesPart(object,part) {
  return object && object.size===part.bytes && object.checksums?.sha256 && b64(object.checksums.sha256)===part.sha256;
}

function photoResponse(object,source) {
  return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    ...(source?{'ETag':object.httpEtag||`"${object.etag}"`}:{})}});
}

// Check the small format header, then send a known-length stream to R2. A
// large original never needs a contiguous Worker-side buffer.
export async function putReservedPhotoPart(bucket,key,request,part) {
  if(!request.body||request.headers.get('Content-Type')!=='application/octet-stream'||Number(request.headers.get('Content-Length'))!==part.bytes)
    fail('InvalidPhotoPart',400);
  const reader=request.body.getReader(), initial=[], header=new Uint8Array(PHOTO_OVERHEAD);
  let offset=0,received=0;
  while(offset<header.length) {
    const {value,done}=await reader.read();
    if(done||received+value.byteLength>part.bytes){await reader.cancel();fail('InvalidPhotoPart',400);}
    initial.push(value);received+=value.byteLength;
    const length=Math.min(value.byteLength,header.length-offset);
    header.set(value.subarray(0,length),offset);offset+=length;
  }
  if(!photoHeader(header)){await reader.cancel();fail('InvalidPhotoPart',400);}
  const input=new ReadableStream({
    async pull(controller) {
      if(initial.length){controller.enqueue(initial.shift());return;}
      const {value,done}=await reader.read();
      if(done) {
        if(received!==part.bytes)controller.error(new Error('InvalidPhotoPart'));
        else controller.close();
        return;
      }
      received+=value.byteLength;
      if(received>part.bytes){await reader.cancel();controller.error(new Error('InvalidPhotoPart'));return;}
      controller.enqueue(value);
    },
    cancel:reason=>reader.cancel(reason)
  });
  const options={onlyIf:{etagDoesNotMatch:'*'},sha256:unb64(part.sha256,43).buffer,httpMetadata:{contentType:'application/octet-stream'}};
  // Node's isolated fixture bucket accepts any stream. Workers R2 requires a
  // known size, so preserve it through its native FixedLengthStream.
  if(typeof FixedLengthStream!=='function')return bucket.put(key,input,options);
  const fixed=new FixedLengthStream(part.bytes),cancel=new AbortController();
  const streamed=input.pipeTo(fixed.writable,{signal:cancel.signal}).then(()=>null,error=>error);
  try {
    const result=await bucket.put(key,fixed.readable,options);
    if(result){const error=await streamed;if(error)throw error;}
    return result;
  } finally {cancel.abort();await streamed;}
}

const sourceFields = ['original_key','display_key','thumbnail_key','household','account_id','session_id','status','metadata','epoch','request_hash','expires_at','retired_at'];
const sameSource = sourceFields.map(field=>`m.${field} IS json_extract(i.source,'$.${field}')`).join(' AND ');

// The existing records receive ordinary signed document envelopes with the
// same scopes. While the candidate is in canonical tables, the D1 control
// marker blocks readers and generic resume until the real backup is restored.
async function applyCandidate(db,job,lease) {
  const sequence = job.sequence;
  const budget=await db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(1000
    +length(CAST(COALESCE(json_extract(p.payload,'$.envelope'),r.envelope) AS BLOB))
    +length(CAST(COALESCE(json_extract(p.payload,'$.summary'),r.summary) AS BLOB))
    +length(CAST(COALESCE(json_extract(p.payload,'$.keyBox'),r.key_box) AS BLOB))
    +length(CAST(COALESCE(json_extract(p.payload,'$.attestation'),r.attestation) AS BLOB))
    +length(CAST(r.photo_ids AS BLOB))),0) AS bytes
    FROM diary_e2ee_records r LEFT JOIN diary_photo_migration_records p ON p.id=r.id`).first();
  if(budget.count>5000||budget.bytes>50_000_000)fail('DiaryCapacityExceeded',413);
  const guard = `phase='encrypted' AND generation=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=?
    AND EXISTS(SELECT 1 FROM diary_photo_migration_job WHERE id=1 AND run=? AND phase='ready' AND lease=? AND lease_until>?)
    AND EXISTS(SELECT 1 FROM diary_e2ee_media m WHERE ${oldPhoto})
    AND NOT EXISTS(SELECT 1 FROM diary_e2ee_media m LEFT JOIN diary_photo_migration_items i ON i.id=m.id
      WHERE ${oldPhoto} AND (i.id IS NULL OR i.verified<>7 OR NOT (${sameSource})))
    AND NOT EXISTS(SELECT 1 FROM diary_e2ee_records r WHERE ${needsRecord} AND NOT EXISTS(
      SELECT 1 FROM diary_photo_migration_records p WHERE p.id=r.id AND p.revision=r.revision))
    AND NOT EXISTS(SELECT 1 FROM diary_photo_migration_records p LEFT JOIN diary_e2ee_records r ON r.id=p.id WHERE r.id IS NULL OR r.revision<>p.revision)`;
  const pick = field => `(SELECT json_extract(payload,'$.${field}') FROM diary_photo_migration_records WHERE id=diary_e2ee_records.id)`;
  const prefix = `${PHOTO_PREFIX}migration/${job.run}/`;
  await db.batch([
    db.prepare(`UPDATE diary_e2ee_control SET phase=CASE WHEN ${guard} THEN 'rekeying' ELSE 'invalid-photo-cutover' END,
      generation=generation+1,evidence=json_set(COALESCE(evidence,'{}'),'$.photoMigration',?) WHERE id=1`)
      .bind(job.control_generation,sequence,job.run,lease,Date.now(),job.run),
    db.prepare(`UPDATE diary_e2ee_records SET revision=${pick('revision')},source_revision=${pick('sourceRevision')},
      envelope=${pick('envelope')},summary=${pick('summary')},key_box=${pick('keyBox')},attestation=${pick('attestation')}
      WHERE id IN (SELECT id FROM diary_photo_migration_records)`),
    db.prepare(`UPDATE diary_e2ee_media AS m SET original_key=?||m.household||'/'||m.id||'/original',
      display_key=?||m.household||'/'||m.id||'/display',thumbnail_key=?||m.household||'/'||m.id||'/thumbnail',
      metadata=(SELECT i.metadata FROM diary_photo_migration_items i WHERE i.id=m.id)
      WHERE ${oldPhoto} AND m.id IN (SELECT id FROM diary_photo_migration_items WHERE verified=7)`).bind(prefix,prefix,prefix),
    db.prepare(`UPDATE diary_photo_migration_job SET phase='checking',control_generation=control_generation+1,
      sequence=(SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes) WHERE id=1`),
    db.prepare("UPDATE diary_e2ee_control SET phase='paused' WHERE id=1 AND phase='rekeying'"),
  ]).catch(()=>fail('PhotoMigrationCutoverConflict'));
  return publicJob(await jobOf(db));
}

export async function handlePhotoMigration(request,env,url,path,{session,actor,bundle,directory,readJson,json,audit=async()=>{}}) {
  if(session.identityId!=='primary-admin'||!actor.isGlobalOwner||!actor.canManageEntries||
    !['tanaka-household','chiharu-household'].every(id=>actor.households.includes(id)))fail('AccessDenied',403);
  if(bundle.rekeyRequired)fail('DiaryRekeyRequired',423);
  const db = env.DB, method=request.method, now=Date.now();
  let job = await jobOf(db);
  const token = request.headers.get('X-Diary-Photo-Session');
  if(!uuid(token))fail('InvalidPhotoMigrationSession',400);
  const lease = `${session.sessionId}:${token}`;
  const control = await readRollout(db);
  if(path==='/status'&&method==='GET')return json(await snapshot(env,job,lease));
  if(job?.phase==='done'&&['/acquire','/finish'].includes(path)&&method==='POST')return json(publicJob(job));
  if(path==='/acquire'&&method==='POST') {
    if(!job) {
      if(control.phase!=='encrypted'||!control.everEncrypted)fail('DiaryWritesPaused',423);
      if(!Number.isFinite(Date.parse(session.startedAt))||now-Date.parse(session.startedAt)>300_000)fail('RecentAuthenticationRequired',428);
      const created=await db.prepare(`INSERT INTO diary_photo_migration_job(id,run,directory_generation,control_generation,phase)
        SELECT 1,?,?,?, 'photos' WHERE EXISTS(SELECT 1 FROM diary_e2ee_control WHERE phase='encrypted' AND generation=?) ON CONFLICT DO NOTHING`)
        .bind(crypto.randomUUID(),directory.generation,control.generation,control.generation).run();
      job=await jobOf(db);
      if(created.meta.changes)await audit('diary_photo_migration_started');
    }
    if(!job||job.directory_generation!==directory.generation||job.control_generation!==control.generation)fail('PhotoMigrationGenerationChanged');
    const saved=await db.prepare("UPDATE diary_photo_migration_job SET lease=?,lease_until=? WHERE id=1 AND phase!='done' AND (lease=? OR lease_until<=?)")
      .bind(lease,now+leaseMs,lease,now).run();
    if(!saved.meta.changes)fail('PhotoMigrationBusy');
    return json(publicJob(await jobOf(db)));
  }
  assertJob(job,directory,control,lease);
  if(path==='/release'&&method==='POST') {
    await db.prepare('UPDATE diary_photo_migration_job SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').bind(lease).run();
    return json({ok:true});
  }
  if(path==='/next'&&method==='GET'&&job.phase==='photos') {
    const next=await db.prepare(`SELECT m.id FROM diary_e2ee_media m LEFT JOIN diary_photo_migration_items i ON i.id=m.id
      WHERE m.id>? AND ${oldPhoto} AND COALESCE(i.verified,0)<>7 ORDER BY m.id LIMIT 1`).bind(job.cursor).first();
    return json(next?await migrationPhoto(db,next.id):{row:null});
  }
  const partRoute=path.match(/^\/(source|target)\/([a-f0-9-]{36})\/(original|display|thumbnail)$/);
  if(partRoute&&job.phase==='photos') {
    const [,which,id,kind]=partRoute,{row,item}=await migrationPhoto(db,id),part=item?.parts[kind];
    if(which==='source'&&method==='GET') {
      const object=await env.MEDIA.get(row[`${kind}_key`],part?{onlyIf:{etagMatches:part.etag}}:undefined);
      if(!object?.body)fail('PhotoSourceChanged');
      if(object.size<1||object.size>limits[kind]*1048576)fail('PhotoMigrationSizeUnsupported',413);
      return photoResponse(object,true);
    }
    if(which==='target'&&part) {
      const key=targetKey(job,row,kind);
      if(method==='GET') {
        const object=await env.MEDIA.get(key);
        if(!object)fail('PhotoMigrationTargetMissing',404);
        if(!matchesPart(object,part))fail('PhotoMigrationTargetConflict');
        return photoResponse(object,false);
      }
      if(method==='PUT') {
        // A late PUT can only create the exact bytes of the same reservation.
        assertJob(await jobOf(db),directory,await readRollout(db),lease);
        const saved=await putReservedPhotoPart(env.MEDIA,key,request,part);
        if(!matchesPart(saved||await env.MEDIA.head(key),part))fail('PhotoMigrationTargetConflict');
        return json({ok:true});
      }
    }
  }
  if(path==='/reserve'&&method==='POST'&&job.phase==='photos') {
    const body=await readJson(request,30_000);
    if(!uuid(body.id)||Object.keys(body.parts||{}).length!==3)fail('InvalidPhotoReservation',400);
    validateEnvelope(body.metadata);
    const {row,item}=await migrationPhoto(db,body.id);
    for(const kind of kinds) {
      const part=body.parts[kind];
      if(!part||Object.keys(part).sort().join(',')!=='bytes,check,etag,sha256'||typeof part.etag!=='string'||!/^[\w-]{1,128}$/.test(part.etag)||!digest(part.sha256)||
        !Number.isSafeInteger(part.bytes)||part.bytes<=PHOTO_OVERHEAD||part.bytes>limits[kind]*1048576+PHOTO_OVERHEAD)fail('InvalidPhotoReservation',400);
      validateEnvelope(part.check);
    }
    if(item) {
      if(!equal(item.metadata,body.metadata)||!equal(item.parts,body.parts))fail('PhotoMigrationReservationConflict');
      return json({ok:true});
    }
    const saved=await db.prepare(`INSERT INTO diary_photo_migration_items(id,household,source,metadata,parts)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM diary_photo_migration_job WHERE id=1 AND phase='photos' AND lease=? AND lease_until>?)
      ON CONFLICT DO NOTHING`).bind(row.id,row.household,JSON.stringify(row),JSON.stringify(body.metadata),JSON.stringify(body.parts),lease,Date.now()).run();
    if(!saved.meta.changes)fail('PhotoMigrationLeaseLost');
    return json({ok:true});
  }
  if(path==='/verify'&&method==='POST'&&job.phase==='photos') {
    const body=await readJson(request,4000),member=directory.members.find(m=>m.credentialId===actor.credentialId);
    const proof=await verifySigned(body,member.signPublicKey);
    const {row,item}=await migrationPhoto(db,proof.id);
    if(!item||!equal(proof,{run:job.run,id:row.id,hashes:kinds.map(kind=>item.parts[kind].sha256)}))fail('PhotoMigrationProofMismatch');
    const bodies=await Promise.all(kinds.map(kind=>env.MEDIA.head(targetKey(job,row,kind))));
    if(bodies.some((object,index)=>!matchesPart(object,item.parts[kinds[index]])))fail('PhotoMigrationTargetConflict');
    const guard="EXISTS(SELECT 1 FROM diary_photo_migration_job WHERE id=1 AND phase='photos' AND lease=? AND lease_until>?)";
    const [result]=await db.batch([
      db.prepare(`UPDATE diary_photo_migration_items SET verified=7 WHERE id=? AND ${guard}`).bind(row.id,lease,Date.now()),
      db.prepare(`UPDATE diary_photo_migration_job SET cursor=MAX(cursor,?) WHERE id=1 AND ${guard}`).bind(row.id,lease,Date.now()),
    ]);
    if(!result.meta.changes)fail('PhotoMigrationLeaseLost');
    return json({ok:true});
  }
  if(path==='/plan'&&method==='POST'&&['photos','records','ready'].includes(job.phase)) {
    const missing=await db.prepare(`SELECT 1 FROM diary_e2ee_media m LEFT JOIN diary_photo_migration_items i ON i.id=m.id
      WHERE ${oldPhoto} AND COALESCE(i.verified,0)<>7 LIMIT 1`).first();
    if(missing)fail('PhotoMigrationIncomplete');
    const seq=await sequenceOf(db);
    if(['records','ready'].includes(job.phase)&&job.sequence===seq)return json(publicJob(job));
    const guard="EXISTS(SELECT 1 FROM diary_photo_migration_job WHERE id=1 AND phase IN ('photos','records','ready') AND lease=? AND lease_until>?)";
    const [,saved]=await db.batch([
      db.prepare(`DELETE FROM diary_photo_migration_records WHERE ${guard}`).bind(lease,Date.now()),
      db.prepare(`UPDATE diary_photo_migration_job SET phase='records',sequence=? WHERE id=1 AND ${guard}`).bind(seq,lease,Date.now()),
    ]);
    if(!saved.meta.changes)fail('PhotoMigrationLeaseLost');
    return json(publicJob(await jobOf(db)));
  }
  if(['records','ready'].includes(job.phase)&&await sequenceOf(db)!==job.sequence)fail('PhotoMigrationEntriesChanged');
  if(path==='/record'&&method==='GET'&&job.phase==='records') {
    const row=await db.prepare(`SELECT r.*,${affectedDraft} AS advance_source FROM diary_e2ee_records r
      WHERE r.id>COALESCE((SELECT MAX(id) FROM diary_photo_migration_records),'') AND ${needsRecord} ORDER BY r.id LIMIT 1`).first();
    if(!row)return json({row:null});
    const {results}=await db.prepare(`SELECT m.*,i.metadata AS candidate FROM diary_e2ee_media m JOIN diary_photo_migration_items i ON i.id=m.id
      WHERE ${oldPhoto} AND i.verified=7 AND m.id IN (SELECT value FROM json_each(?))`).bind(row.photo_ids).all();
    return json({row:parseRecord(row),advanceSource:Boolean(row.advance_source),media:results});
  }
  if(path==='/record'&&method==='POST'&&job.phase==='records') {
    const row=await readJson(request,1_800_000);
    await verifyRecord(row,directory,{currentRecipients:true});
    const raw=await db.prepare(`SELECT r.*,${affectedDraft} AS advance_source FROM diary_e2ee_records r WHERE r.id=? AND ${needsRecord}`).bind(row.id).first();
    if(!raw||row.attestation.writer!==actor.credentialId)fail('PhotoMigrationRecordMismatch');
    const old=parseRecord(raw),sourceRevision=raw.advance_source?old.sourceRevision+1:old.sourceRevision;
    if(!equal(bindingOf(row),{...bindingOf(old),revision:old.revision+1,sourceRevision})||
      Boolean(Object.keys(row.keyBox).length)!==Boolean(Object.keys(old.keyBox).length))fail('PhotoMigrationRecordMismatch');
    const result=await db.prepare(`INSERT INTO diary_photo_migration_records(id,revision,payload) SELECT ?,?,?
      WHERE EXISTS(SELECT 1 FROM diary_photo_migration_job WHERE id=1 AND phase='records' AND lease=? AND lease_until>?) ON CONFLICT DO NOTHING`)
      .bind(row.id,old.revision,JSON.stringify(row),lease,Date.now()).run();
    if(!result.meta.changes) {
      const saved=await db.prepare('SELECT payload FROM diary_photo_migration_records WHERE id=?').bind(row.id).first();
      if(!saved||!equal(JSON.parse(saved.payload),row))fail('PhotoMigrationRecordMismatch');
    }
    return json({ok:true});
  }
  if(path==='/ready'&&method==='POST'&&job.phase==='records') {
    const missing=await db.prepare(`SELECT 1 FROM diary_e2ee_records r WHERE ${needsRecord} AND NOT EXISTS(
      SELECT 1 FROM diary_photo_migration_records p WHERE p.id=r.id AND p.revision=r.revision) LIMIT 1`).first();
    if(missing)fail('PhotoMigrationIncomplete');
    const result=await db.prepare(`UPDATE diary_photo_migration_job SET phase='ready' WHERE id=1 AND phase='records'
      AND lease=? AND lease_until>? AND sequence=(SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)`).bind(lease,Date.now()).run();
    if(!result.meta.changes)fail('PhotoMigrationEntriesChanged');
    return json(publicJob(await jobOf(db)));
  }
  if(path==='/apply'&&method==='POST'&&job.phase==='ready') {
    if(!Number.isFinite(Date.parse(session.startedAt))||now-Date.parse(session.startedAt)>300_000)fail('RecentAuthenticationRequired',428);
    const candidate=await applyCandidate(db,job,lease);
    await audit('diary_photo_migration_restore_started');
    return json(candidate);
  }
  if(job.phase==='checking') {
    if(await sequenceOf(db)!==job.sequence)fail('PhotoMigrationCutoverConflict');
    const directoryGeneration=directory.generation;
    if(path==='/backup'&&method==='POST')return json(await createEncryptionCheckpoint(env,{directoryGeneration}));
    if(path==='/backup'&&method==='GET') {
      const part=url.searchParams.get('part');
      return json(await readEncryptionCheckpoint(env,{directoryGeneration,checkpoint:url.searchParams.get('checkpoint'),part:part===null?undefined:Number(part)}));
    }
    if(path==='/proof-rows'&&method==='GET') {
      const after=url.searchParams.get('after')||'';
      const {results}=await db.prepare(`SELECT m.id, m.household, i.parts FROM diary_e2ee_media m JOIN diary_photo_migration_items i ON i.id=m.id
        WHERE m.id>? AND m.original_key LIKE ? ORDER BY m.id LIMIT 20`).bind(after,`${PHOTO_PREFIX}migration/${job.run}/%`).all();
      return json({rows:results,next:results.length===20?results.at(-1).id:null});
    }
    const proofTarget=path.match(/^\/proof-target\/([a-f0-9-]{36})\/(original|display|thumbnail)$/);
    if(proofTarget&&method==='GET') {
      const [,id,kind]=proofTarget;
      const item=await db.prepare('SELECT * FROM diary_photo_migration_items WHERE id=? AND verified=7').bind(id).first();
      if(!item)fail('PhotoMigrationTargetMissing',404);
      const object=await env.MEDIA.get(targetKey(job,item,kind));
      if(!matchesPart(object,JSON.parse(item.parts)[kind]))fail('PhotoMigrationTargetConflict');
      return photoResponse(object,false);
    }
    if(path==='/finish'&&method==='POST') {
      const body=await readJson(request,8000),member=directory.members.find(m=>m.credentialId===actor.credentialId);
      const proof=await verifySigned(body,member.signPublicKey);
      if(!uuid(proof.checkpoint)||!equal(proof,{run:job.run,sequence:job.sequence,checkpoint:proof.checkpoint,sha256:proof.sha256})||
        !/^[a-f0-9]{64}$/.test(proof.sha256))fail('PhotoMigrationRestoreMismatch');
      const backup=await readEncryptionCheckpoint(env,{directoryGeneration,checkpoint:proof.checkpoint});
      if(!backup.ready||backup.sha256!==proof.sha256)fail('PhotoMigrationRestoreMismatch');
      const end=Date.now(),until=end+PHOTO_RETENTION_MS;
      await db.batch([
        db.prepare(`UPDATE diary_e2ee_control SET phase=CASE WHEN phase='paused' AND generation=? AND json_extract(evidence,'$.photoMigration')=?
          AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=? AND EXISTS(SELECT 1 FROM diary_photo_migration_job WHERE id=1 AND phase='checking' AND lease=? AND lease_until>?)
          THEN 'encrypted' ELSE 'invalid-photo-cutover' END,generation=generation+1,
          evidence=json_set(json_remove(evidence,'$.photoMigration'),'$.photoMigrationRetention',json_object('run',?,'until',?,'sha256',?)) WHERE id=1`)
          .bind(job.control_generation,job.run,job.sequence,lease,end,job.run,until,proof.sha256),
        db.prepare("UPDATE diary_photo_migration_job SET phase='done',retained_until=?,restore_sha256=?,lease=NULL,lease_until=0 WHERE id=1").bind(until,proof.sha256),
      ]).catch(()=>fail('PhotoMigrationCutoverConflict'));
      await audit('diary_photo_migration_completed');
      return json(publicJob(await jobOf(db)));
    }
  }
  fail('UnknownPhotoMigrationRoute',404);
}
