import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWindowsSync,deviceChallengeMessage } from '../src/windows-sync.js';
import { handleWindowsUpdates,abortStaleWindowsUploads } from '../src/windows-updates.js';
import { fileContentVersion } from '../src/file-version.js';
import { db,env,context,handoff,api } from './session-fixture.mjs';

context.handleWindowsSync=handleWindowsSync;context.handleWindowsUpdates=handleWindowsUpdates;
env.WINDOWS_SYNC_ENABLED='true';env.TRASH_PURGE_EMERGENCY_STOP='false';
const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
env.SECURITY.cloudWindowsDeviceContext=async()=>({valid:true,authorityVersion:'a'.repeat(64),
  publicKeyJwk:await crypto.subtle.exportKey('jwk',rsa.publicKey),folderKeys:[{rootFolderId:7,serviceLinkId:'fixture',wrappedKey:'wrapped'}]});
let batch=Promise.resolve();env.DB.batch=statements=>{
  const task=batch.then(async()=>{db.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}});
  batch=task.catch(()=>{});return task;
};
const objects=new Map(),uploads=new Map();let completeCalls=0;
env.FILES={
  async createMultipartUpload(key){const uploadId=crypto.randomUUID();uploads.set(uploadId,{key,parts:new Map()});return{uploadId,async abort(){uploads.delete(uploadId);}};},
  resumeMultipartUpload(key,id){return{
    async uploadPart(partNumber,body){const upload=uploads.get(id);assert.equal(upload.key,key);const bytes=Buffer.from(await new Response(body).arrayBuffer()),etag=crypto.randomUUID();upload.parts.set(partNumber,{bytes,etag});return{partNumber,etag};},
    async complete(parts){completeCalls++;const upload=uploads.get(id);if(!upload)throw new Error('NoSuchUpload');
      objects.set(key,Buffer.concat(parts.map(p=>{const part=upload.parts.get(p.partNumber);assert.equal(part.etag,p.etag);return part.bytes;})));uploads.delete(id);},
    async abort(){uploads.delete(id);}
  };},
  async head(key){return objects.has(key)?{size:objects.get(key).length}:null;},
  async get(key,options){
    const bytes=objects.get(key);if(!bytes)return null;
    const requested=options?.range?.get?.('Range'),match=requested?.match(/^bytes=(\d+)-(\d*)$/);
    const offset=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2])+1,bytes.length):bytes.length;
    return{body:new Blob([bytes.subarray(offset,end)]).stream(),size:bytes.length,range:match?{offset,length:end-offset}:undefined,
      httpEtag:'"fixture"',writeHttpMetadata(headers){headers.set('Content-Type','application/octet-stream');}};
  },
  async delete(key){for(const item of Array.isArray(key)?key:[key])objects.delete(item);}
};
async function call(device,path,method='GET',body){
  const response=await context.worker.fetch(new Request('https://tanaka-note.com/cloud/api/windows-sync/data'+path,{method,
    headers:{'Content-Type':'application/json',...(device?{Authorization:'Bearer '+device.accessToken}:{})},
    body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil(){}});
  return{status:response.status,body:await response.json()};
}
async function register(){
  const session=await handoff('folder-member'),key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const send=async(path,body)=>{
    const response=await context.worker.fetch(new Request('https://tanaka-note.com/cloud/api/windows-sync/'+path,{method:'POST',
      headers:{'Content-Type':'application/json',Cookie:session.cookie,'X-TCloud-Session':session.body.sessionCacheId},body:JSON.stringify(body)}),env,{waitUntil(){}});
    assert.equal(response.status,200);return response.json();
  };
  const exported=await crypto.subtle.exportKey('jwk',key.publicKey);
  const challenge=await send('enroll/challenge',{publicKeyJwk:{kty:exported.kty,crv:exported.crv,x:exported.x,y:exported.y}});
  const signature=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,deviceChallengeMessage(challenge))).toString('base64url');
  return send('enroll/complete',{deviceId:challenge.deviceId,challengeId:challenge.challengeId,nonce:challenge.nonce,signature});
}
const device=await register();
const epoch=()=>db.prepare('SELECT epoch FROM cloud_windows_catalog_control').get().epoch;
const revision=id=>db.prepare("SELECT seq FROM cloud_windows_heads WHERE kind='file' AND entity_id=?").get(id).seq;
const base64=value=>Buffer.from(value).toString('base64url');
async function metadata(name,key){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('T-ROOM Cloud Storage file metadata v1')},key,
    new TextEncoder().encode(JSON.stringify({name,mimeType:'text/plain',mediaKind:'document',lastModified:1})));
  return{encryptedMetadata:base64(ciphertext),metadataIv:base64(iv)};
}
async function name(row,key){return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(row.metadata_iv,'base64url'),
  additionalData:new TextEncoder().encode('T-ROOM Cloud Storage file metadata v1')},key,Buffer.from(row.encrypted_metadata,'base64url')))).name;}
async function input(fileId=null){
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const data={operationId:crypto.randomUUID().replaceAll('-',''),epoch:epoch(),folderId:7,sizeBytes:128,cryptoVersion:1,
    encryptedSizeBytes:160,chunkSizeBytes:8*1024*1024,chunkCount:1,wrappedFileKey:'wrapped',fileKeyIv:'iv',
    ...await metadata('document.txt',key)};
  if(fileId){data.fileId=fileId;data.expectedRevision=revision(fileId);}
  return{data,key};
}
async function original(){
  const {data,key}=await input();const oldKey='originals/'+crypto.randomUUID(),thumbnail='thumbnails/'+crypto.randomUUID();
  const stored=db.prepare(`INSERT INTO cloud_files(folder_id,object_key,thumbnail_key,original_name,mime_type,media_kind,size_bytes,status,created_by,
    crypto_version,encrypted_metadata,metadata_iv,wrapped_file_key,file_key_iv,encrypted_size_bytes,chunk_size_bytes,chunk_count)
    VALUES(7,?,?,'[encrypted]','application/octet-stream','other',128,'ready','member',1,?,?,'oldWrap','oldIv',160,8388608,1)`)
    .run(oldKey,thumbnail,data.encryptedMetadata,data.metadataIv);
  const id=Number(stored.lastInsertRowid);objects.set(oldKey,Buffer.alloc(160,1));objects.set(thumbnail,Buffer.alloc(20,3));
  return{id,key,oldKey,thumbnail};
}
async function revisionInput(old){const value=await input(old.id);value.key=old.key;Object.assign(value.data,await metadata('document.txt',old.key),{wrappedFileKey:'oldWrap',fileKeyIv:'oldIv'});
  value.data.archiveRestore={...await metadata('document (旧版-'+value.data.operationId.slice(0,8)+').txt',old.key)};return value;}
async function send(data){
  const created=await call(device,'/windows-updates','POST',data);assert.equal(created.status,201,JSON.stringify(created.body));
  const row=db.prepare('SELECT * FROM cloud_files WHERE id=?').get(created.body.uploadId);
  const part=await env.FILES.resumeMultipartUpload(row.object_key,row.multipart_upload_id).uploadPart(1,new Uint8Array(160).fill(2));
  return{...created.body,parts:[part],objectKey:row.object_key};
}
const finish=upload=>call(device,'/windows-updates/'+upload.operationId+'/complete','POST',{parts:upload.parts});

test('new Windows uploads are idempotent and isolated from other devices and Web completion',async()=>{
  const {data}=await input(),upload=await send(data),second=await call(device,'/windows-updates','POST',data);
  assert.equal(second.status,200);assert.equal(second.body.uploadId,upload.uploadId);
  assert.equal((await call(device,'/windows-updates','POST',{...data,encryptedMetadata:'different'})).status,409);
  const other=await register();assert.equal((await call(other,'/windows-updates/'+data.operationId)).status,404);
  const cookie=await handoff('admin');
  assert.equal((await api(cookie.cookie,'/uploads/'+upload.uploadId+'/complete','POST',{parts:upload.parts},{'X-TCloud-Session':cookie.body.sessionCacheId})).status,409);
  const completed=await finish(upload);assert.equal(completed.status,200,JSON.stringify(completed.body));assert.equal(completed.body.fileId,upload.uploadId);
  const calls=completeCalls;assert.equal((await finish(upload)).status,200);assert.equal(completeCalls,calls,'lost completion response does not repeat the R2 completion');
  const file=db.prepare('SELECT * FROM cloud_files WHERE id=?').get(upload.uploadId);assert.equal(file.status,'ready');assert.equal(file.created_by,'member');
  assert.equal(completed.body.revision,revision(file.id));
});

test('one transaction retains the old body in online trash and restore uses a distinct encrypted name',async()=>{
  const old=await original(),{data,key}=await revisionInput(old),upload=await send(data);
  const results=await Promise.all([finish(upload),finish(upload)]);for(const response of results)assert.equal(response.status,200,JSON.stringify(response.body));
  const latest=db.prepare('SELECT * FROM cloud_files WHERE id=?').get(old.id),archived=db.prepare('SELECT * FROM cloud_files WHERE id=?').get(upload.uploadId);
  assert.equal(latest.object_key,upload.objectKey);assert.equal(latest.thumbnail_key,null);assert.equal(await name(latest,key),'document.txt');
  assert.equal(archived.object_key,old.oldKey);assert.equal(archived.thumbnail_key,old.thumbnail);assert.equal(archived.wrapped_file_key,'oldWrap');
  assert.ok(archived.deleted_at);assert.ok(archived.trash_operation_id);assert.equal(await name(archived,old.key),'document.txt');
  assert.equal(db.prepare('SELECT count(*) AS n FROM cloud_file_versions WHERE source_file_id=?').get(old.id).n,1);
  const admin=await handoff('admin'),restored=await api(admin.cookie,'/files/'+archived.id+'/restore','POST',{}, {'X-TCloud-Session':admin.body.sessionCacheId});
  assert.equal(restored.status,200,JSON.stringify(restored.body));const restoredFile=db.prepare('SELECT * FROM cloud_files WHERE id=?').get(archived.id);
  assert.equal(restoredFile.deleted_at,null);assert.match(await name(restoredFile,old.key),/旧版-/);
  assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=?').get(old.id).object_key,upload.objectKey,'restore preserves the current file and content');
  assert.ok(objects.has(old.oldKey)&&objects.has(upload.objectKey),'both original bodies remain independently available');
  const pinned=await context.worker.fetch(new Request(`https://tanaka-note.com/cloud/api/files/${old.id}/view?contentVersion=${await fileContentVersion({object_key:old.oldKey})}`,
    {headers:{Cookie:admin.cookie,'X-TCloud-Session':admin.body.sessionCacheId,Range:'bytes=16-47'}}),env,{waitUntil(){}});
  assert.equal(pinned.status,206);assert.deepEqual(Buffer.from(await pinned.arrayBuffer()),Buffer.alloc(32,1),
    'a previously opened content version still resolves the old ciphertext after overwrite and distinct-name restoration');
  const current=await api(admin.cookie,'/files/'+old.id,'GET',undefined,{'X-TCloud-Session':admin.body.sessionCacheId});
  assert.equal(current.body.file.contentVersion,await fileContentVersion({object_key:upload.objectKey}));
  const listing=await api(admin.cookie,'/items?folderId=7','GET',undefined,{'X-TCloud-Session':admin.body.sessionCacheId});
  assert.equal(listing.status,200);assert.equal(listing.body.files.find(f=>f.id===old.id).contentVersion,current.body.file.contentVersion);
  assert.equal(listing.body.files.some(f=>Object.hasOwn(f,'_contentKey')||Object.hasOwn(f,'object_key')),false,'immutable body tokens never expose R2 keys in listing payloads');
});

test('concurrent rename and online trash prevent an old edit from overwriting or resurrecting the original',async()=>{
  for(const trash of [false,true]){
    const old=await original(),{data}=await revisionInput(old),upload=await send(data);
    if(trash){const admin=await handoff('admin');assert.equal((await api(admin.cookie,'/files/'+old.id,'DELETE',undefined,{'X-TCloud-Session':admin.body.sessionCacheId})).status,200);}
    else db.prepare('UPDATE cloud_files SET metadata_iv=? WHERE id=?').run('newerIv',old.id);
    const response=await finish(upload);assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(response.body.code,'revision_conflict');
    assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=?').get(old.id).object_key,old.oldKey);
    assert.equal(db.prepare('SELECT count(*) AS n FROM cloud_file_versions WHERE source_file_id=?').get(old.id).n,0);
    assert.equal(db.prepare('SELECT state FROM cloud_windows_uploads WHERE id=?').get(data.operationId).state,'pending');
    assert.equal((await call(device,'/windows-updates/'+data.operationId+'/cancel','POST',{})).status,200);
    assert.ok(objects.has(old.oldKey));assert.equal(objects.has(upload.objectKey),false,'aborting removes only the unpublished new ciphertext');
  }
});

test('audit failure rolls back parking, archive and current pointer; retry reuses the completed ciphertext',async()=>{
  const old=await original(),{data}=await revisionInput(old),upload=await send(data);
  db.exec("CREATE TRIGGER reject_windows_audit BEFORE INSERT ON cloud_audit_logs WHEN NEW.event_type='file_updated' BEGIN SELECT RAISE(ABORT,'fixture_audit_failure'); END;");
  try{assert.equal((await finish(upload)).status,503);}finally{db.exec('DROP TRIGGER reject_windows_audit');}
  assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=?').get(old.id).object_key,old.oldKey);
  assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=?').get(upload.uploadId).object_key,upload.objectKey);
  assert.equal(db.prepare('SELECT count(*) AS n FROM cloud_file_versions WHERE source_file_id=?').get(old.id).n,0);
  const calls=completeCalls;assert.equal((await finish(upload)).status,200);assert.equal(completeCalls,calls);
});

test('scope, catalog epoch and restore metadata are checked before a revision is accepted',async()=>{
  const old=await original(),{data}=await revisionInput(old);
  assert.equal((await call(device,'/windows-updates','POST',{...data,folderId:9})).status,403);
  assert.equal((await call(device,'/windows-updates','POST',{...data,epoch:'f'.repeat(32)})).status,409);
  assert.equal((await call(device,'/windows-updates','POST',{...data,archiveRestore:null})).status,400);
  assert.equal((await call(device,'/windows-updates','POST',{...data,expectedRevision:data.expectedRevision-1})).status,409);
});

test('folder creation survives concurrent requests and lost replies without duplicating the folder or audit',async()=>{
  const body={operationId:crypto.randomUUID().replaceAll('-',''),epoch:epoch(),parentId:7,name:'Native child',cryptoVersion:1,
    encryptedName:'encrypted-name',nameIv:'name-iv',adminWrappedKey:'admin-wrap',parentWrappedKey:'parent-wrap',parentWrapIv:'parent-iv'};
  const results=await Promise.all([call(device,'/windows-folders','POST',body),call(device,'/windows-folders','POST',body)]);
  for(const response of results)assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(results[0].body.id,results[1].body.id);
  const created=db.prepare('SELECT * FROM cloud_folders WHERE id=?').get(results[0].body.id);assert.equal(created.parent_id,7);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cloud_audit_logs WHERE event_type='folder_created' AND target_id=?").get(created.id).n,1);
  assert.equal((await call(device,'/windows-folders','POST',{...body,nameIv:'another'})).status,409);
  assert.equal((await call(device,'/windows-folders','POST',{...body,parentId:9})).status,403);
});

test('an authorized move and overwrite commits together while preserving the old version in its original folder',async()=>{
  const old=await original(),{data}=await revisionInput(old);Object.assign(data,{folderId:8,wrappedFileKey:'new-parent-wrap',fileKeyIv:'new-parent-iv'});
  const upload=await send(data);assert.equal((await finish(upload)).status,200);
  assert.equal(db.prepare('SELECT folder_id FROM cloud_files WHERE id=?').get(old.id).folder_id,8);
  assert.equal(db.prepare('SELECT folder_id FROM cloud_files WHERE id=?').get(upload.uploadId).folder_id,7);
  assert.equal(db.prepare('SELECT archive_json FROM cloud_windows_uploads WHERE id=?').get(data.operationId).archive_json,null,'completed transient restore copies are removed');
});

test('stale interrupted uploads remove only unpublished bodies and preserve the current original',async()=>{
  const old=await original(),{data}=await revisionInput(old),upload=await send(data);
  await env.FILES.resumeMultipartUpload(upload.objectKey,db.prepare('SELECT multipart_upload_id FROM cloud_files WHERE id=?').get(upload.uploadId).multipart_upload_id).complete(upload.parts);
  db.prepare("UPDATE cloud_windows_uploads SET created_at=datetime('now','-2 day') WHERE id=?").run(data.operationId);
  await abortStaleWindowsUploads(env);
  assert.equal(objects.has(upload.objectKey),false);assert.ok(objects.has(old.oldKey));
  assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=?').get(old.id).object_key,old.oldKey);
  assert.equal(db.prepare('SELECT state FROM cloud_windows_uploads WHERE id=?').get(data.operationId).state,'aborted');
});

test('purging an archived old version never deletes the current ciphertext or metadata',async()=>{
  const old=await original(),{data}=await revisionInput(old),upload=await send(data);assert.equal((await finish(upload)).status,200);
  const admin=await handoff('admin');
  const removed=await api(admin.cookie,'/files/'+upload.uploadId+'/permanent','DELETE',undefined,{'X-TCloud-Session':admin.body.sessionCacheId});
  assert.equal(removed.status,200,JSON.stringify(removed.body));assert.equal(objects.has(old.oldKey),false);assert.equal(objects.has(upload.objectKey),true);
  assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=?').get(old.id).object_key,upload.objectKey);
});
