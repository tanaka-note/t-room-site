import assert from 'node:assert/strict';
import {db,env,context} from './session-fixture.mjs';
const before=process.argv.includes('--reproduce');
const token='A'.repeat(43),hash=await context.sha256Base64Url(token);
db.prepare(`INSERT INTO cloud_shares(id,token_hash,encrypted_token,token_iv,target_type,target_id,password_hash,password_salt,password_wrapped_key,password_wrap_iv,expires_at,created_by) VALUES(1,?,'fixture','fixture','folder',7,'fixture','fixture','fixture','fixture',?,'admin')`).run(hash,Math.floor(Date.now()/1000)+3600);
const share=db.prepare('SELECT * FROM cloud_shares WHERE id=1').get();
const cookie='troom_cloud_share_session='+await context.createShareSessionToken(share,'fixture',3600,env);
let reads=0;
env.FILES.get=async()=>{reads++;return {body:new Uint8Array([1,2,3]),size:3,httpEtag:'"fixture"',writeHttpMetadata(){}};};
db.exec("UPDATE cloud_files SET display_metadata_version=1,display_media_kind='image',display_thumbnail_key='fixture' WHERE id=1");
const get=(suffix,auth=cookie)=>context.worker.fetch(new Request('https://example.test/cloud/api/public/shares/'+token+suffix,{headers:auth?{Cookie:auth}:{}}),env,{waitUntil(){}});
assert.equal((await get('/files/1/thumbnail')).status,404);
assert.equal((await get('/files/1/display-thumbnail',null)).status,401);
const response=await get('/files/1/display-thumbnail');
assert.equal(response.status,before?401:200);
if(!before){
  assert.match(response.headers.get('Cache-Control'),/no-store/);
  assert.equal(reads,1);
  const otherCookie='troom_cloud_share_session='+await context.createShareSessionToken({...share,id:2},'fixture',3600,env);
  assert.equal((await get('/files/1/display-thumbnail',otherCookie)).status,401);
  for(const version of [0,2]){
    db.prepare('UPDATE cloud_files SET display_metadata_version=? WHERE id=1').run(version);
    assert.equal((await get('/files/1/display-thumbnail')).status,404);
  }
  db.exec('UPDATE cloud_files SET display_metadata_version=1 WHERE id=1');
  assert.equal((await get('/files/2/display-thumbnail')).status,403);
  assert.equal(reads,1);
  for(const kind of ['video','audio','unknown',null]){
    db.prepare('UPDATE cloud_files SET display_media_kind=? WHERE id=1').run(kind);
    assert.equal((await get('/files/1/display-thumbnail')).status,404);
  }
  db.exec("UPDATE cloud_files SET display_media_kind='image',deleted_at=CURRENT_TIMESTAMP WHERE id=1");
  assert.equal((await get('/files/1/display-thumbnail')).status,404);
  db.exec("UPDATE cloud_files SET deleted_at=NULL,status='uploading' WHERE id=1");
  assert.equal((await get('/files/1/display-thumbnail')).status,404);
  db.exec("UPDATE cloud_files SET status='ready' WHERE id=1; UPDATE cloud_shares SET stopped_at=1 WHERE id=1");
  assert.equal((await get('/files/1/display-thumbnail')).status,410);
  assert.equal(reads,1);
  db.exec("UPDATE cloud_shares SET stopped_at=NULL,expires_at=1 WHERE id=1");
  assert.equal((await get('/files/1/display-thumbnail')).status,410);
  db.prepare('UPDATE cloud_shares SET expires_at=?,target_type=\'file\',target_id=1 WHERE id=1').run(Math.floor(Date.now()/1000)+3600);
  assert.equal((await get('/files/1/display-thumbnail')).status,200);
  assert.equal((await get('/files/2/display-thumbnail')).status,403);
  db.exec('INSERT INTO cloud_share_files(share_id,file_id) VALUES(1,1)');
  assert.equal((await get('/files/1/display-thumbnail')).status,200);
  assert.equal((await get('/files/2/display-thumbnail')).status,403);
  db.exec("DELETE FROM cloud_share_files; UPDATE cloud_shares SET target_type='folder',target_id=7; INSERT INTO cloud_share_folders(share_id,folder_id) VALUES(1,7)");
  assert.equal((await get('/files/1/display-thumbnail')).status,200);
  assert.equal((await get('/files/2/display-thumbnail')).status,403);
}
console.log(before?'REPRODUCED share display-only image has no authorized endpoint':'PASS share display thumbnail authentication, membership, image-only, readiness, revocation, no-store');
