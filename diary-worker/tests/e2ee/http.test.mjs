import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { systemFixture } from './system-fixture.mjs';
import { EncryptedDiaryClient } from '../../e2ee/client.mjs';
import { readSnapshotPages } from '../../e2ee/snapshot.mjs';
import { createEncryptedDiaryApi } from '../../e2ee/ui-api.mjs';
import { diaryKeyBundle,handleDiaryKeys } from '../../../security-worker/src/diary-keys.js';
import { entry } from './fixture.mjs';
import { seal } from '../../e2ee/crypto.mjs';
import { preferencesScope } from '../../e2ee/policy.mjs';
let f;before(async()=>{f=await systemFixture();});after(async()=>{await f.close();});
async function call(path,{account='main-admin',method='GET',body,headers={},rawBody}={}) {
  const origin=f.env.DIARY_ENCRYPTION_ORIGIN;
  const input={method,headers:{Cookie:f.cookie(account),...(method==='GET'?{}:{Origin:origin,'X-Diary-Request':'1'}),...headers}};
  if(body!==undefined){input.headers['Content-Type']='application/json';input.body=JSON.stringify(body);}if(rawBody)input.body=rawBody;
  return f.worker.fetch(new Request(`${origin}/diary/api${path}`,input),f.env,f.ctx);
}
async function client(account='main-admin') {
  const user=f.users[account];
  const request=async(path,method='GET',body)=>{const response=await call('/encryption'+path,{account,method,body});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;};
  const profile=await request('/profile');
  const transport={valid:async()=>(await (await call('/session',{account})).json()).authenticated,timestamp:async()=>(await request('/time')).timestamp,snapshot:(h,since)=>readSnapshotPages(options=>request(`/snapshot?${new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))}`),h,since),mutation:(proposal,operation)=>request('/mutation','POST',{proposal,operation}),remove:value=>request('/remove','POST',value)};
  const instance=new EncryptedDiaryClient({transport,profile:profile.profile,anchor:f.configuration.anchor,documentFormat:2});await instance.unlock(new Uint8Array(user.prf));return instance;
}
test('same WebAuthn credential has separate account recipients and private preferences',async()=>{
  const owner=await diaryKeyBundle(f.centralEnv,f.users['main-admin']),ordinary=await diaryKeyBundle(f.centralEnv,f.users['main-user']);
  assert.ok(owner&&ordinary);assert.notEqual(owner.recipientId,ordinary.recipientId);assert.equal(owner.webAuthnCredentialId,ordinary.webAuthnCredentialId);
  const a=await client(),b=await client('main-user'),e=(await a.saveEntry(entry())).entry;
  await a.setFavorite(e.id,true);await b.sync();assert.equal(b.entry(e.id).isFavorite,false);
});
test('actual Worker never serves legacy entry metadata after encrypted cutover',async()=>{
  for(const path of ['/bootstrap','/entries','/meta','/photos']){const response=await call(path);assert.equal(response.status,426,path);}
  const response=await call('/entries',{method:'POST',body:entry()});assert.equal(response.status,426);
  const dumped=JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all());assert.equal(dumped.includes(entry().title),false);
});
test('household parameters cannot override signed session scope',async()=>{
  const response=await call('/encryption/snapshot?household=chiharu-household&since=-1',{account:'main-user'});assert.equal(response.status,403);
});
test('pause prevents encrypted writes and preserves existing ciphertext',async()=>{
  const a=await client();await a.sync();const before=f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all();
  f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='paused',generation=generation+1");
  try{await assert.rejects(a.saveEntry(entry({title:'must not save'})),error=>error.status===423);assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all(),before);await a.sync();}
  finally{f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='encrypted',generation=generation+1");}
});
test('lost or mismatched links do not receive a key bundle',async()=>{
  const person=f.users['main-admin'];assert.equal(await diaryKeyBundle(f.centralEnv,{...person,serviceLinkId:f.users['main-user'].serviceLinkId}),null);
  f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(f.users['wife-admin'].credentialId);
  try{assert.equal(await diaryKeyBundle(f.centralEnv,f.users['wife-admin']),null);const profile=await diaryKeyBundle(f.centralEnv,person);assert.equal(profile.rekeyRequired,true);}
  finally{f.central.sqlite.prepare("UPDATE security_credentials SET status='active' WHERE credential_id=?").run(f.users['wife-admin'].credentialId);}
});
test('photo staging keeps filename/dimensions encrypted, attaches atomically, and retires only unreferenced media',async()=>{
  const a=await client(),scope=preferencesScope(a.household,a.actor.accountId),epoch=a.directory.epochs[scope];
  const session=await (await call('/encryption/uploads',{method:'POST',body:{targetEntryId:null}})).json();
  const sid=session.uploadSession.id,id=crypto.randomUUID(),photo={id,fileName:'PHOTO_PRIVATE_CANARY.jpg',contentType:'image/jpeg',originalSize:3,width:123,height:456,createdAt:'2026-11-11T00:00:00Z',thumbnailUrl:`/diary/api/photos/${id}/thumbnail`,displayUrl:`/diary/api/photos/${id}/display`,originalUrl:`/diary/api/photos/${id}/original`};
  const metadata=await seal(a.keys.get(scope),photo,{household:a.household,scope,id,revision:1,epoch,kind:'photo-staging',sourceId:sid});
  const form=()=>{const value=new FormData();value.set('id',id);value.set('epoch',String(epoch));value.set('metadata',JSON.stringify(metadata));for(const kind of ['original','display','thumbnail'])value.set(kind,new Blob([new Uint8Array([1,2,3])],{type:'application/octet-stream'}),`${kind}.bin`);return value;};
  const route=`/encryption/uploads/${sid}/photos`;
  assert.equal((await call(route,{method:'POST',rawBody:form()})).status,200);
  assert.equal((await call(route,{method:'POST',rawBody:form()})).status,200,'retry is idempotent');
  assert.equal(f.r2.size,3);
  const dump=JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_media WHERE id=?').get(id));assert.equal(dump.includes(photo.fileName),false);assert.equal(dump.includes('width'),false);
  assert.equal((await call(`/photos/${id}/original`)).status,404,'unattached photo is not served');
  const saved=(await a.saveEntry(entry({content:`body[[写真:${id}]]`,pendingPhotoIds:[id]}))).entry;
  await a.attachPhotos(saved.id,[photo]);
  assert.equal(f.db.sqlite.prepare('SELECT status FROM diary_e2ee_media WHERE id=?').get(id).status,'attached');
  const commit=`/encryption/uploads/${sid}/commit`,body={entryId:saved.id,photoIds:[id]};
  assert.equal((await call(commit,{method:'POST',body})).status,200);assert.equal((await call(commit,{method:'POST',body})).status,200);
  assert.equal((await call(`/photos/${id}/original`)).status,200);
  assert.equal((await call(`/photos/${id}/original`,{account:'chiharu-admin'})).status,404);
  assert.equal((await call(`/encryption/media/${id}`,{method:'DELETE'})).status,200);assert.equal(f.r2.size,3,'referenced original is preserved');
  await a.deletePhoto(id,a.entry(saved.id).revision);
  assert.equal((await call(`/encryption/media/${id}`,{method:'DELETE'})).status,200);assert.equal(f.r2.size,0);
});
