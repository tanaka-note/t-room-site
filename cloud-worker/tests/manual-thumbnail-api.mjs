import assert from 'node:assert/strict';
import {db,env,context,api,handoff} from './session-fixture.mjs';
globalThis.window=globalThis;
await import('../public/crypto-vault.js');
const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const plain=new Blob(['local synthetic thumbnail']);
const encrypted=await TRoomCrypto.encryptThumbnail(plain,key);
db.exec("UPDATE cloud_files SET crypto_version=1,thumbnail_key='thumbnails/existing',updated_at='2020-01-01 00:00:00' WHERE id=1");
const writes=[];env.FILES.put=async(key,body,options)=>writes.push({key,bytes:new Uint8Array(body),options});
const admin=await handoff('admin'),member=await handoff('folder-member');
const sub=await api(null,'/login','POST',{loginId:'subadmin@test',authProof:'local-proof'});
assert.equal(sub.status,200,JSON.stringify(sub.body));
const send=async(login,body=encrypted,id=1)=>context.worker.fetch(new Request(`https://example.test/cloud/api/files/${id}/thumbnail/manual`,{
 method:'PUT',headers:{Origin:'https://example.test',Cookie:login.cookie,'X-TCloud-Session':login.body.sessionCacheId,'Content-Type':'application/octet-stream'},body
}),env,{waitUntil(){}});
for(const login of [member,sub])assert.equal((await send(login)).status,403);
assert.equal(writes.length,0);
assert.equal((await send(admin,new Blob(['plain image data'.repeat(10)]))).status,400);
assert.equal((await send(admin,new Blob([new Uint8Array(2*1024*1024+1)]))).status,413);
assert.equal((await send(admin,encrypted,99999)).status,404);
const response=await send(admin);assert.equal(response.status,200);
const result=await response.json();assert.notEqual(result.updatedAt,'2020-01-01 00:00:00');
assert.equal(writes.length,1);assert.equal(writes[0].key,'thumbnails/existing');
assert.equal(writes[0].options.httpMetadata.contentType,'application/octet-stream');
assert.equal(new TextDecoder().decode(await TRoomCrypto.decryptThumbnail(writes[0].bytes,key)),await plain.text());
const audit=db.prepare("SELECT * FROM cloud_audit_logs WHERE event_type='video_thumbnail_manual_updated'").get();
assert.equal(audit.actor_role,'admin');assert.equal(audit.target_id,1);assert.equal(audit.details_json,null);
db.exec("UPDATE cloud_files SET deleted_at=CURRENT_TIMESTAMP WHERE id=1");assert.equal((await send(admin)).status,404);
console.log('PASS manual thumbnail admin-only, encrypted envelope/size bounds, ready/trash guards, object replacement, version and minimal audit');

