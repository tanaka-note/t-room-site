import assert from 'node:assert/strict';
import {db,env,context} from './session-fixture.mjs';
globalThis.window=globalThis;await import('../public/crypto-vault.js');
const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const plain=new Blob(['local share image fixture']),encrypted=new Uint8Array(await(await TRoomCrypto.encryptThumbnail(plain,key)).arrayBuffer());
const token='A'.repeat(43),hash=await context.sha256Base64Url(token);
db.prepare(`INSERT INTO cloud_shares(id,token_hash,encrypted_token,token_iv,target_type,target_id,password_hash,password_salt,password_wrapped_key,password_wrap_iv,expires_at,created_by) VALUES(1,?,'fixture','fixture','folder',7,'fixture','fixture','fixture','fixture',?,'admin')`).run(hash,Math.floor(Date.now()/1000)+3600);
const share=db.prepare('SELECT * FROM cloud_shares WHERE id=1').get();
const cookie='troom_cloud_share_session='+await context.createShareSessionToken(share,'fixture',3600,env);
let reads=0;
env.FILES.get=async objectKey=>{assert.equal(objectKey,'thumbnails/fixture');reads++;return {body:encrypted,size:encrypted.length,httpEtag:'"fixture"',writeHttpMetadata(){}};};
db.exec("UPDATE cloud_files SET crypto_version=1,media_kind='other',display_metadata_version=1,display_media_kind='image',display_thumbnail_key='display-thumbnails/fixture' WHERE id=1");
const get=(suffix,auth=cookie)=>context.worker.fetch(new Request('https://example.test/cloud/api/public/shares/'+token+suffix,{headers:auth?{Cookie:auth}:{}}),env,{waitUntil(){}});
assert.equal((await get('/files/1/thumbnail')).status,404);
assert.equal((await get('/files/1/display-thumbnail',null)).status,401);
assert.equal((await get('/files/1/display-thumbnail')).status,404,'old clients may fall back instead of treating the share as expired');
assert.equal(reads,0,'retired endpoint never reads plaintext R2');
db.exec("UPDATE cloud_files SET thumbnail_key='thumbnails/fixture' WHERE id=1");
const response=await get('/files/1/thumbnail');assert.equal(response.status,200);
assert.match(response.headers.get('Cache-Control'),/no-store/);
assert.equal(new TextDecoder().decode(await TRoomCrypto.decryptThumbnail(await response.arrayBuffer(),key)),await plain.text());
const otherCookie='troom_cloud_share_session='+await context.createShareSessionToken({...share,id:2},'fixture',3600,env);
for(const suffix of ['thumbnail','display-thumbnail']){
 assert.equal((await get('/files/1/'+suffix,null)).status,401);
 assert.equal((await get('/files/1/'+suffix,otherCookie)).status,401);
 assert.equal((await get('/files/2/'+suffix)).status,403);
}
for(const kind of ['video','image','audio','unknown',null]){
 db.prepare('UPDATE cloud_files SET display_media_kind=?,display_metadata_version=0 WHERE id=1').run(kind);
 assert.equal((await get('/files/1/thumbnail')).status,200,'encrypted thumbnail needs no plaintext display kind');
 assert.equal((await get('/files/1/display-thumbnail')).status,404);
}
const beforeDenied=reads;
db.exec("UPDATE cloud_files SET deleted_at=CURRENT_TIMESTAMP WHERE id=1");assert.equal((await get('/files/1/thumbnail')).status,404);
db.exec("UPDATE cloud_files SET deleted_at=NULL,status='uploading' WHERE id=1");assert.equal((await get('/files/1/thumbnail')).status,404);
db.exec("UPDATE cloud_files SET status='ready' WHERE id=1; UPDATE cloud_shares SET stopped_at=1 WHERE id=1");assert.equal((await get('/files/1/thumbnail')).status,410);
db.exec('UPDATE cloud_shares SET stopped_at=NULL,expires_at=1 WHERE id=1');assert.equal((await get('/files/1/thumbnail')).status,410);
assert.equal(reads,beforeDenied);
db.prepare("UPDATE cloud_shares SET expires_at=?,target_type='file',target_id=1 WHERE id=1").run(Math.floor(Date.now()/1000)+3600);
assert.equal((await get('/files/1/thumbnail')).status,200);assert.equal((await get('/files/2/thumbnail')).status,403);
db.exec('INSERT INTO cloud_share_files(share_id,file_id) VALUES(1,1)');
assert.equal((await get('/files/1/thumbnail')).status,200);assert.equal((await get('/files/2/thumbnail')).status,403);
db.exec("DELETE FROM cloud_share_files; UPDATE cloud_shares SET target_type='folder',target_id=7; INSERT INTO cloud_share_folders(share_id,folder_id) VALUES(1,7)");
assert.equal((await get('/files/1/thumbnail')).status,200);assert.equal((await get('/files/2/thumbnail')).status,403);
console.log('PASS encrypted share thumbnails: old-client fallback, authentication, file/selection/folder membership, readiness, revocation, no-store');
