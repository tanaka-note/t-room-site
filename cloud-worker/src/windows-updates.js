import { windowsCatalogScope } from './windows-catalog.js';
import { fileContentVersion } from './file-version.js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
class UpdateError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status,code)=>{throw new UpdateError(status,code);};
const integer=value=>Number.isSafeInteger(value)&&value>0?value:fail(400,'invalid_update');
const operation=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value)?value:fail(400,'invalid_operation');
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const fileColumns=['folder_id','object_key','thumbnail_key','stream_uid','original_name','mime_type','media_kind','size_bytes','status',
  'multipart_upload_id','created_by','created_at','updated_at','deleted_at','crypto_version','encrypted_metadata','metadata_iv',
  'wrapped_file_key','file_key_iv','encrypted_size_bytes','chunk_size_bytes','chunk_count','display_metadata_version','display_name',
  'display_mime_type','display_media_kind','display_last_modified','display_duration_seconds','display_thumbnail_key','trash_operation_id','purge_id'];

async function own(env,id,session) {
  const row=await env.DB.prepare('SELECT * FROM cloud_windows_uploads WHERE id=? AND device_id=?').bind(id,session.windowsDeviceId).first();
  if(!row)fail(404,'operation_not_found');return row;
}
async function result(row){return {operationId:row.id,uploadId:row.upload_id,fileId:row.file_id||row.upload_id,state:row.state,
  revision:row.result_revision,archiveId:row.file_id&&row.state==='committed'?row.upload_id:null,
  contentVersion:row.state==='committed'?await fileContentVersion({object_key:row.object_key}):null};}
async function folder(env,id,session,deps) {
  await deps.requireFolderAccess(env,id,session);
  const row=await env.DB.prepare('SELECT ancestors FROM cloud_windows_folder_projection WHERE entity_id=?').bind(id).first();
  if(!row||!windowsCatalogScope(JSON.parse(row.ancestors),session))fail(403,'folder_unavailable');
  return row.ancestors;
}
async function start(request,env,session,deps) {
  deps.requireUpload(session);
  const body=await deps.readJson(request,32768),id=operation(body.operationId),folderId=integer(body.folderId),size=integer(body.sizeBytes);
  if(size>64*1024*1024*10000||body.cryptoVersion!==1)fail(400,'invalid_update');
  if(typeof body.epoch!=='string'||!/^[a-f0-9]{32}$/.test(body.epoch))fail(400,'invalid_epoch');
  const fileId=body.fileId==null?null:integer(body.fileId),revision=fileId?integer(body.expectedRevision):null;
  const encrypted=deps.normalizeEncryptedFile(body,size),display=deps.normalizeFastDisplayMetadata(body.fastDisplay);
  const restore=body.archiveRestore==null?null:{
    encryptedMetadata:body.archiveRestore.encryptedMetadata==null?null:deps.validCryptoText(body.archiveRestore.encryptedMetadata,4096,'復元情報'),
    metadataIv:body.archiveRestore.metadataIv==null?null:deps.validCryptoText(body.archiveRestore.metadataIv,64,'復元情報IV'),
    name:body.archiveRestore.name==null?null:deps.validName(body.archiveRestore.name),
    displayName:body.archiveRestore.displayName==null?null:deps.validName(body.archiveRestore.displayName)
  };
  const fingerprint=await hash(JSON.stringify([body.epoch,fileId,revision,folderId,size,encrypted,display,restore]));
  const previous=await env.DB.prepare('SELECT * FROM cloud_windows_uploads WHERE id=?').bind(id).first();
  if(previous) {
    if(previous.device_id!==session.windowsDeviceId||previous.body_hash!==fingerprint)fail(409,'operation_mismatch');
    return json(await result(previous));
  }
  const control=await env.DB.prepare('SELECT epoch FROM cloud_windows_catalog_control WHERE id=1').first();
  if(control?.epoch!==body.epoch)fail(409,'catalog_reset');
  const ancestors=await folder(env,folderId,session,deps);
  let sourceAncestors=null;
  if(fileId) {
    deps.requireFileEdit(session);await deps.requireTrashCutoverReady(env);
    const old=await env.DB.prepare(`SELECT f.*,h.seq FROM cloud_files f JOIN cloud_windows_heads h ON h.kind='file' AND h.entity_id=f.id
      WHERE f.id=? AND f.status='ready' AND f.deleted_at IS NULL AND f.purge_id IS NULL`).bind(fileId).first();
    if(!old||old.seq!==revision)fail(409,'revision_conflict');
    sourceAncestors=await folder(env,old.folder_id,session,deps);
    if(old.folder_id!==folderId)await deps.requireMemberMoveScope(env,old.folder_id,folderId,session);
    if(old.folder_id===folderId&&old.crypto_version===1&&(encrypted.wrappedFileKey!==old.wrapped_file_key||encrypted.fileKeyIv!==old.file_key_iv))fail(400,'file_key_changed');
    if(old.crypto_version===1&&encrypted.metadataIv===old.metadata_iv)fail(400,'metadata_nonce_reused');
    if(!restore||old.crypto_version===1&&(!restore.encryptedMetadata||!restore.metadataIv||restore.name)
      ||old.crypto_version!==1&&(!restore.name||restore.encryptedMetadata||restore.metadataIv))fail(400,'restore_name_required');
  }else if(restore)fail(400,'invalid_update');
  const objectKey='originals/'+crypto.randomUUID(),upload=await env.FILES.createMultipartUpload(objectKey,{httpMetadata:{contentType:'application/octet-stream'}});
  try {
    const inserted=await env.DB.batch([
      env.DB.prepare(`INSERT INTO cloud_files(folder_id,object_key,original_name,mime_type,media_kind,size_bytes,multipart_upload_id,created_by,
        crypto_version,encrypted_metadata,metadata_iv,wrapped_file_key,file_key_iv,encrypted_size_bytes,chunk_size_bytes,chunk_count,
        display_metadata_version,display_name,display_mime_type,display_media_kind,display_last_modified,display_duration_seconds)
        VALUES(?,?,'[encrypted]','application/octet-stream','other',?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(folderId,objectKey,size,upload.uploadId,'windows:'+session.windowsDeviceId,
          encrypted.encryptedMetadata,encrypted.metadataIv,encrypted.wrappedFileKey,encrypted.fileKeyIv,
          encrypted.encryptedSizeBytes,encrypted.chunkSizeBytes,encrypted.chunkCount,display?1:0,display?.name||null,
          display?.mimeType||null,display?.mediaKind||null,display?.lastModified||null,display?.durationSeconds||null),
      env.DB.prepare(`INSERT INTO cloud_windows_uploads(id,device_id,body_hash,epoch,file_id,expected_revision,upload_id,object_key,folder_id,
        ancestors,source_ancestors,archive_json,trash_operation_id) VALUES(?,?,?,?,?,?,(SELECT id FROM cloud_files WHERE object_key=?),?,?,?,?,?,?)`)
        .bind(id,session.windowsDeviceId,fingerprint,body.epoch,fileId,revision,objectKey,objectKey,folderId,ancestors,sourceAncestors,
          restore?JSON.stringify(restore):null,fileId?crypto.randomUUID():null)
    ]);
    if(inserted[1].meta.changes!==1)fail(503,'update_unavailable');
  } catch(error) {
    await upload.abort().catch(()=>{});
    const winner=await env.DB.prepare('SELECT * FROM cloud_windows_uploads WHERE id=?').bind(id).first();
    if(winner?.device_id===session.windowsDeviceId&&winner.body_hash===fingerprint)return json(await result(winner));
    throw error;
  }
  return json(await result(await own(env,id,session)),201);
}
async function complete(request,env,session,deps,id) {
  deps.requireUpload(session);const op=await own(env,id,session);
  if(op.state==='committed')return json(await result(op));
  if(op.state!=='pending')fail(409,'operation_closed');
  const body=await deps.readJson(request,1000000),parts=body.parts;
  if(!Array.isArray(parts)||parts.length<1||parts.length>10000||parts.some((p,i)=>p.partNumber!==i+1||typeof p.etag!=='string'||!p.etag||p.etag.length>256))
    fail(400,'invalid_parts');
  const ancestors=await folder(env,op.folder_id,session,deps);
  if(ancestors!==op.ancestors)fail(409,'revision_conflict');
  if(op.file_id){deps.requireFileEdit(session);await deps.requireTrashCutoverReady(env);}
  const fresh=await env.DB.prepare("SELECT * FROM cloud_files WHERE id=? AND status='uploading' AND created_by=?")
    .bind(op.upload_id,'windows:'+session.windowsDeviceId).first();
  if(!fresh)fail(409,'upload_expired');
  let stored=await env.FILES.head(op.object_key);
  if(!stored) {
    try {await env.FILES.resumeMultipartUpload(op.object_key,fresh.multipart_upload_id).complete(parts);}
    catch(error){if(!await env.FILES.head(op.object_key)) {
      if(/InvalidPart|invalid (?:part|etag)/i.test(String(error?.message||'')))fail(409,'parts_retry_required');
      throw error;
    }}
    stored=await env.FILES.head(op.object_key);
  }
  if(!stored||Number(stored.size)!==fresh.encrypted_size_bytes)fail(502,'stored_size_mismatch');
  const old=op.file_id?await env.DB.prepare('SELECT * FROM cloud_files WHERE id=?').bind(op.file_id).first():null;
  if(op.file_id&&!old)fail(409,'revision_conflict');
  const timestamp=new Date().toISOString(),target=op.file_id||op.upload_id;
  const commands=[env.DB.prepare(`UPDATE cloud_windows_uploads SET state=CASE WHEN state='pending'
      AND epoch=(SELECT epoch FROM cloud_windows_catalog_control WHERE id=1)
      AND EXISTS(SELECT 1 FROM cloud_windows_devices d WHERE d.id=device_id AND d.revoked_at IS NULL)
      AND ancestors=(SELECT ancestors FROM cloud_windows_folder_projection WHERE entity_id=folder_id)
      AND EXISTS(SELECT 1 FROM cloud_files WHERE id=upload_id AND status='uploading' AND object_key=? AND deleted_at IS NULL)
      AND (file_id IS NULL OR (EXISTS(SELECT 1 FROM cloud_files f JOIN cloud_windows_heads h ON h.kind='file' AND h.entity_id=f.id
        JOIN cloud_windows_folder_projection p ON p.entity_id=f.folder_id
        WHERE f.id=file_id AND p.ancestors=source_ancestors AND f.status='ready' AND f.deleted_at IS NULL
        AND f.purge_id IS NULL AND h.seq=expected_revision) AND (SELECT cutover_ready FROM cloud_trash_control WHERE id=1)=1))
      THEN 'committing' ELSE 'conflict' END WHERE id=? AND device_id=?`).bind(op.object_key,id,session.windowsDeviceId)];
  const active="EXISTS(SELECT 1 FROM cloud_windows_uploads WHERE id=? AND state='committing')";
  if(old) {
    const restore=JSON.parse(op.archive_json);
    // object_key is UNIQUE. Park the unpublished upload inside this transaction,
    // then move both references. This parking key is never read from R2.
    commands.push(env.DB.prepare(`UPDATE cloud_files SET object_key=? WHERE id=? AND ${active}`)
      .bind('windows-staging/'+id,op.upload_id,id));
    const latest={...fresh,id:target,created_by:old.created_by,created_at:old.created_at,status:'ready',multipart_upload_id:null,updated_at:timestamp};
    commands.push(env.DB.prepare(`UPDATE cloud_files SET ${fileColumns.map(c=>c+'=?').join(',')} WHERE id=? AND ${active}`)
      .bind(...fileColumns.map(c=>latest[c]??null),target,id));
    commands.push(env.DB.prepare(`INSERT INTO cloud_trash_operations(id,deleted_at,target_type,target_id)
      SELECT ?,?,'file',? WHERE ${active}`).bind(op.trash_operation_id,timestamp,op.upload_id,id));
    const archived={...old,status:'ready',multipart_upload_id:null,updated_at:timestamp,deleted_at:timestamp,trash_operation_id:op.trash_operation_id,purge_id:null};
    commands.push(env.DB.prepare(`UPDATE cloud_files SET ${fileColumns.map(c=>c+'=?').join(',')} WHERE id=? AND ${active}`)
      .bind(...fileColumns.map(c=>archived[c]??null),op.upload_id,id));
    commands.push(env.DB.prepare(`INSERT INTO cloud_file_versions(file_id,source_file_id,source_revision,operation_id,content_version,restore_metadata,restore_iv,restore_name,restore_display_name)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${active}`)
      .bind(op.upload_id,target,op.expected_revision,id,await fileContentVersion(old),restore.encryptedMetadata,restore.metadataIv,restore.name,restore.displayName,id));
  }else commands.push(env.DB.prepare(`UPDATE cloud_files SET status='ready',multipart_upload_id=NULL,created_by=?,updated_at=? WHERE id=? AND ${active}`)
    .bind(session.role,timestamp,target,id));
  commands.push(env.DB.prepare(`UPDATE cloud_windows_uploads SET state=CASE WHEN state='committing'
      AND EXISTS(SELECT 1 FROM cloud_files WHERE id=? AND status='ready' AND deleted_at IS NULL AND object_key=cloud_windows_uploads.object_key)
      AND (file_id IS NULL OR EXISTS(SELECT 1 FROM cloud_files f JOIN cloud_file_versions v ON v.file_id=f.id
        WHERE f.id=upload_id AND f.deleted_at=? AND f.trash_operation_id=cloud_windows_uploads.trash_operation_id AND v.operation_id=cloud_windows_uploads.id))
      THEN 'committed' ELSE 'conflict' END,
      result_revision=(SELECT seq FROM cloud_windows_heads WHERE kind='file' AND entity_id=?),completed_at=?,archive_json=NULL WHERE id=? AND device_id=?`)
    .bind(target,timestamp,target,timestamp,id,session.windowsDeviceId));
  commands.push(env.DB.prepare(`INSERT INTO cloud_audit_logs(event_type,actor_role,target_type,target_id,details_json)
      SELECT ?,?,'file',?,? WHERE EXISTS(SELECT 1 FROM cloud_windows_uploads WHERE id=? AND state='committed')`)
    .bind(old?'file_updated':'upload_completed',session.role,target,JSON.stringify({operationId:id,previousRevision:op.expected_revision,archiveId:old?op.upload_id:null}),id));
  try {await env.DB.batch(commands);}
  catch(error) {
    const latest=await own(env,id,session);if(latest.state==='committed')return json(await result(latest));
    if(String(error.message).includes('windows_update_transition')||String(error.message).includes('trash_'))fail(409,'revision_conflict');
    throw error;
  }
  const committed=await own(env,id,session);if(committed.state!=='committed')fail(409,'revision_conflict');
  return json(await result(committed));
}
async function cancel(env,session,id) {
  const op=await own(env,id,session);if(op.state==='committed')fail(409,'operation_closed');
  await env.DB.prepare("UPDATE cloud_windows_uploads SET state='aborting' WHERE id=? AND device_id=? AND state IN ('pending','aborting')")
    .bind(id,session.windowsDeviceId).run();
  const claimed=await own(env,id,session);if(claimed.state==='aborted')return json(await result(claimed));
  if(claimed.state!=='aborting')fail(409,'operation_closed');
  const file=await env.DB.prepare("SELECT * FROM cloud_files WHERE id=? AND status='uploading'").bind(op.upload_id).first();
  if(file) {
    await env.FILES.resumeMultipartUpload(op.object_key,file.multipart_upload_id).abort().catch(()=>{});
    // A completed upload may have lost its response. The abort claim prevents
    // any concurrent commit before this unreferenced encrypted body is removed.
  }
  await env.FILES.delete(op.object_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cloud_files WHERE id=? AND status='uploading'").bind(op.upload_id),
    env.DB.prepare("UPDATE cloud_windows_uploads SET state='aborted' WHERE id=? AND state='aborting'").bind(id)
  ]);
  return json(await result(await own(env,id,session)));
}
export async function handleWindowsUpdates(request,env,path,session,deps) {
  try {
    if(!session.windowsDeviceId)fail(403,'device_required');
    if(path==='/api/windows-folders'&&request.method==='POST')return await createFolder(request,env,session,deps);
    if(path==='/api/windows-updates'&&request.method==='POST')return await start(request,env,session,deps);
    const match=path.match(/^\/api\/windows-updates\/([a-f0-9]{32})(?:\/(complete|cancel))?$/);
    if(!match)fail(404,'not_found');
    if(request.method==='GET'&&!match[2])return json(await result(await own(env,match[1],session)));
    if(request.method==='POST'&&match[2]==='complete')return await complete(request,env,session,deps,match[1]);
    if(request.method==='POST'&&match[2]==='cancel')return await cancel(env,session,match[1]);
    fail(403,'operation_not_allowed');
  }catch(error) {
    if(error instanceof UpdateError)return json({code:error.code,error:error.code},error.status);
    throw error;
  }
}

async function createFolder(request,env,session,deps) {
  deps.requireUpload(session);const body=await deps.readJson(request,8192),id=operation(body.operationId),parent=integer(body.parentId);
  if(body.cryptoVersion!==1||typeof body.epoch!=='string'||!/^[a-f0-9]{32}$/.test(body.epoch)
    ||['authProof','passwordSalt','passwordWrappedKey','passwordWrapIv'].some(k=>body[k]!=null))fail(400,'invalid_folder');
  const ancestors=await folder(env,parent,session,deps),name=deps.validName(body.name);
  const encrypted=deps.normalizeEncryptedFolder(body,false),wrapped=deps.normalizeParentWrappedFolder(body,true);
  const owner='windows:'+session.windowsDeviceId+':folder:'+id;
  await env.DB.batch([env.DB.prepare(`INSERT INTO cloud_folders(parent_id,name,created_by,crypto_version,encrypted_name,name_iv,admin_wrapped_key,parent_wrapped_key,parent_wrap_iv)
    SELECT ?,?,?,1,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM cloud_folders WHERE created_by=?)
    AND EXISTS(SELECT 1 FROM cloud_windows_folder_projection p JOIN cloud_folders f ON f.id=p.entity_id WHERE p.entity_id=? AND p.ancestors=? AND f.deleted_at IS NULL)
    AND EXISTS(SELECT 1 FROM cloud_windows_devices WHERE id=? AND status='active' AND revoked_at IS NULL)
    AND EXISTS(SELECT 1 FROM cloud_windows_catalog_control WHERE id=1 AND epoch=?)`)
    .bind(parent,name,owner,encrypted.encryptedName,encrypted.nameIv,encrypted.adminWrappedKey,wrapped.parentWrappedKey,wrapped.parentWrapIv,
      owner,parent,ancestors,session.windowsDeviceId,body.epoch),
    env.DB.prepare(`INSERT INTO cloud_audit_logs(event_type,actor_role,target_type,target_id,details_json)
      SELECT 'folder_created',?,'folder',id,? FROM cloud_folders WHERE created_by=? AND changes()>0`)
      .bind(session.role,JSON.stringify({operationId:id,windows:true}),owner)]);
  const created=await env.DB.prepare('SELECT id,encrypted_name,name_iv FROM cloud_folders WHERE created_by=?').bind(owner).first();
  if(!created||created.encrypted_name!==encrypted.encryptedName||created.name_iv!==encrypted.nameIv)fail(409,'folder_conflict');
  return json({id:created.id,operationId:id});
}

export async function abortStaleWindowsUploads(env) {
  const exists=await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='cloud_windows_uploads'").first();
  if(!exists)return;
  const rows=await env.DB.prepare("SELECT id,device_id FROM cloud_windows_uploads WHERE state IN ('pending','aborting') AND created_at<datetime('now','-1 day') LIMIT 100").all();
  for(const row of rows.results||[]) {
    try {await cancel(env,{windowsDeviceId:row.device_id},row.id);}
    catch(error){if(!(error instanceof UpdateError&&error.code==='operation_closed'))throw error;}
  }
}
