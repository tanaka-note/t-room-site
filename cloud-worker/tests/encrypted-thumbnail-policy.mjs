import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {db,env,context,handoff} from './session-fixture.mjs';
globalThis.window=globalThis;await import('../public/crypto-vault.js');
const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const plaintext=new Blob(['local synthetic thumbnail'.repeat(4)]),encrypted=await TRoomCrypto.encryptThumbnail(plaintext,key);
const admin=await handoff('admin'),member=await handoff('folder-member');
const writes=[];env.FILES.put=async(key,body)=>writes.push({key,bytes:new Uint8Array(await new Response(body).arrayBuffer())});
db.exec("UPDATE cloud_files SET crypto_version=1,media_kind='other',thumbnail_key=NULL,created_by='admin' WHERE id=1");
const put=(body,suffix='thumbnail',login=admin)=>context.worker.fetch(new Request(`https://example.test/cloud/api/files/1/${suffix}`,{
 method:'PUT',headers:{Origin:'https://example.test',Cookie:login.cookie,'X-TCloud-Session':login.body.sessionCacheId,'Content-Type':'application/octet-stream'},body
}),env,{waitUntil(){}});
assert.equal((await put(plaintext)).status,400,'normal thumbnail uploads reject plaintext');
assert.equal((await put(new Blob([new Uint8Array([84,82,84,72])]))).status,400);
assert.equal((await put(new Blob([new Uint8Array(2*1024*1024+1)]))).status,413);
assert.equal((await put(encrypted,'thumbnail',member)).status,403);
assert.equal((await put(plaintext,'display-thumbnail')).status,410,'old clients cannot upload plaintext');
assert.equal(writes.length,0);
assert.equal((await put(encrypted)).status,200);
assert.equal(writes.length,1);assert.ok(writes[0].key.startsWith('thumbnails/'));
assert.equal(new TextDecoder().decode(await TRoomCrypto.decryptThumbnail(writes[0].bytes,key)),await plaintext.text());
db.exec('UPDATE cloud_files SET crypto_version=NULL WHERE id=1');
assert.equal((await put(plaintext)).status,400,'legacy files cannot introduce new plaintext thumbnails');
assert.equal(writes.length,1);
for(const name of ['cloud.js','share.js'])assert.doesNotMatch(readFileSync(new URL('../public/'+name,import.meta.url),'utf8'),/display-thumbnail/);
assert.doesNotMatch(readFileSync(new URL('../src/index.js',import.meta.url),'utf8'),/`display-thumbnails\//);
console.log('PASS encrypted thumbnail policy: bounded TRTH only, old plaintext endpoint disabled, no plaintext client upload');
