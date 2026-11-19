import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWindowsSync, cleanupWindowsSync, deviceChallengeMessage, windowsDataRoute } from '../src/windows-sync.js';
import { db, env, context, api, handoff, securityDb } from './session-fixture.mjs';

context.handleWindowsSync=handleWindowsSync; context.cleanupWindowsSync=cleanupWindowsSync;
const audits=[];const originalAudit=context.recordSecurityAudit;
context.recordSecurityAudit=async(...args)=>{audits.push(args[2]);return originalAudit(...args);};
env.WINDOWS_SYNC_ENABLED='true';
let generation='a'.repeat(64), unavailable=false;
const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
let rsaPublic=await crypto.subtle.exportKey('jwk',rsa.publicKey);
env.SECURITY.cloudWindowsDeviceContext=async input=> {
  if (unavailable) throw new Error('Synthetic outage');
  if (input.serviceAccountId!=='folder-member'||input.cloudRootFolderId!==7) return null;
  return {valid:true,authorityVersion:generation,publicKeyJwk:rsaPublic,folderKeys:[{rootFolderId:7,serviceLinkId:input.serviceLinkId,wrappedKey:'wrapped'}]};
};
// D1 batch is atomic and serialized. Exercise competing proofs with real SQLite.
let batch=Promise.resolve();
env.DB.batch=statements=> {
  const run=batch.then(async()=>{db.exec('BEGIN IMMEDIATE');try {const results=[]; for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}});
  batch=run.catch(()=>{}); return run;
};
async function call(path,method='GET',data,headers={}) {
  const response=await context.worker.fetch(new Request('https://tanaka-note.com/cloud/api/windows-sync'+path,{method,
    headers:{'Content-Type':'application/json',...headers},body:data===undefined?undefined:JSON.stringify(data)}),env,{waitUntil(){}});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('Set-Cookie')};
}
async function register(activate=true) {
  const session=await handoff('folder-member');
  const headers={Cookie:session.cookie,'X-TCloud-Session':session.body.sessionCacheId};
  const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const exported=await crypto.subtle.exportKey('jwk',key.publicKey);
  const publicKeyJwk={kty:exported.kty,crv:exported.crv,x:exported.x,y:exported.y};
  const challenge=await call('/enroll/challenge','POST',{publicKeyJwk},headers);
  assert.equal(challenge.status,200,JSON.stringify(challenge.body));
  const sign=async value=>({deviceId:value.deviceId,challengeId:value.challengeId,nonce:value.nonce,
    signature:Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,deviceChallengeMessage(value))).toString('base64url')});
  const initialProof=await sign(challenge.body);
  if(!activate)return {session,headers,key,sign,initialProof,challenge:challenge.body};
  const complete=await call('/enroll/complete','POST',initialProof,headers);
  assert.equal(complete.status,200,JSON.stringify(complete.body));
  return {session,headers,key,sign,initialProof,challenge:challenge.body,authorization:{Authorization:'Bearer '+complete.body.accessToken},token:complete.body};
}
test('initial passkey enrollment issues a separate, non-cookie, limited Windows authorization',async()=>{
  const device=await register();
  assert.equal((await call('/enroll/complete','POST',device.initialProof,device.headers)).status,401,'one-use proof cannot be replayed');
  assert.equal((await call('/keys','GET',undefined,device.authorization)).status,200);
  const items=await call('/data/items','GET',undefined,device.authorization);
  assert.equal(items.status,200); assert.deepEqual(items.body.folders.map(f=>f.id),[7]); assert.equal(items.cookie,null);
  assert.equal((await call('/data/items?folderId=9','GET',undefined,device.authorization)).status,403);
  assert.equal((await call('/data/folders/7','PATCH',{name:'changed',passwordAction:'replace',authProof:'fixture'},device.authorization)).status,403);
  const position=db.prepare("SELECT seq FROM cloud_windows_heads WHERE kind='folder' AND entity_id=8").get();
  const epoch=db.prepare('SELECT epoch FROM cloud_windows_catalog_control WHERE id=1').get().epoch;
  assert.equal((await call('/data/folders/8','PATCH',{name:'renamed child',passwordAction:'keep',windowsExpectedRevision:position.seq,windowsEpoch:epoch},device.authorization)).status,200,'ordinary folder rename still works');
  for(const route of ['/data/files/1','/data/folders/7','/data/trash'])
    assert.equal((await call(route,'DELETE',undefined,device.authorization)).status,403,'no native original deletion');
  assert.equal((await api(null,'/items','GET',undefined,device.authorization)).status,401,'device bearer grants no Web session');
  const raw=db.prepare('SELECT * FROM cloud_windows_access WHERE device_id=?').get(device.token.deviceId);
  assert.notEqual(raw.token_hash,device.token.accessToken); assert.match(raw.token_hash,/^[a-f0-9]{64}$/);
  assert.equal((await call('/enroll/challenge','POST',{publicKeyJwk:{kty:'EC',crv:'P-256',x:'x',y:'y',d:'private'}},device.headers)).status,400);
  assert.equal((await call('/challenge','POST',{deviceId:device.token.deviceId},{Origin:'https://attacker.test'})).status,403);
});
test('Web logout and a year without a Web session do not require another passkey for Windows renewal',async()=>{
  const device=await register();
  assert.equal((await api(device.session.cookie,'/logout','POST',{}, {'X-TCloud-Session':device.session.body.sessionCacheId})).status,200);
  const realNow=Date.now;Date.now=()=>realNow()+365*86400*1000;
  try {
    assert.equal((await call('/keys','GET',undefined,device.authorization)).body.code,'access_expired');
    const challenge=await call('/challenge','POST',{deviceId:device.token.deviceId});assert.equal(challenge.status,200);
    const result=await call('/token','POST',await device.sign(challenge.body));assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.cookie,null);assert.equal(result.body.scopeHash,device.challenge.scopeHash);
    assert.equal((await call('/keys','GET',undefined,{Authorization:'Bearer '+result.body.accessToken})).status,200);
  } finally {Date.now=realNow;}
});

test('saved device keys recover a lost activation within the original window, never an expired or revoked registration',async()=>{
  const pending=await register(false),deviceId=pending.challenge.deviceId;
  assert.equal((await api(pending.session.cookie,'/logout','POST',{}, {'X-TCloud-Session':pending.session.body.sessionCacheId})).status,200);
  const challenge=await call('/challenge','POST',{deviceId});assert.equal(challenge.status,200);
  const wrong=await pending.sign({...challenge.body,scopeHash:'f'.repeat(64)});
  assert.equal((await call('/token','POST',wrong)).status,401);
  assert.equal(db.prepare('SELECT status FROM cloud_windows_devices WHERE id=?').get(deviceId).status,'pending');
  const recovered=await call('/token','POST',await pending.sign(challenge.body));
  assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.cookie,null);
  assert.equal(db.prepare('SELECT status FROM cloud_windows_devices WHERE id=?').get(deviceId).status,'active');
  assert.equal((await call('/keys','GET',undefined,{Authorization:'Bearer '+recovered.body.accessToken})).status,200);
  const racing=await register(false),racingId=racing.challenge.deviceId;
  const first=(await call('/challenge','POST',{deviceId:racingId})).body,second=(await call('/challenge','POST',{deviceId:racingId})).body;
  const auditStart=audits.length;
  const raced=await Promise.all([call('/token','POST',await racing.sign(first)),call('/token','POST',await racing.sign(second))]);
  assert.deepEqual(raced.map(value=>value.status),[200,200]);
  assert.equal(audits.slice(auditStart).filter(event=>event.eventType==='windows_device_registered').length,1,'parallel recovery activates the existing grant only once');
  const expired=await register(false),expiredId=expired.challenge.deviceId;
  const expiring=(await call('/challenge','POST',{deviceId:expiredId})).body;
  db.prepare('UPDATE cloud_windows_devices SET enrollment_expires_at=0 WHERE id=?').run(expiredId);
  assert.equal((await call('/challenge','POST',{deviceId:expiredId})).body.code,'initial_auth_incomplete');
  assert.equal((await call('/token','POST',await expired.sign(expiring))).body.code,'initial_auth_incomplete');
  assert.equal(db.prepare('SELECT status FROM cloud_windows_devices WHERE id=?').get(expiredId).status,'pending');
  const revoked=await register(false),revokedId=revoked.challenge.deviceId;
  db.prepare("UPDATE cloud_windows_devices SET status='revoked' WHERE id=?").run(revokedId);
  assert.equal((await call('/challenge','POST',{deviceId:revokedId})).body.code,'device_revoked');
});
test('concurrent proofs consume exactly once; tampering cannot enlarge scope or change the device',async()=>{
  const device=await register();
  const challenge=(await call('/challenge','POST',{deviceId:device.token.deviceId})).body;
  const bad=await device.sign({...challenge,scopeHash:'b'.repeat(64)});
  assert.equal((await call('/token','POST',bad)).status,401);
  assert.ok(audits.some(event=>event.eventType==='windows_device_proof_failure'&&event.outcome==='failure'&&event.authMethod==='windows-device'));
  const good=await device.sign(challenge);
  const results=await Promise.all([call('/token','POST',good),call('/token','POST',good)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);
  const other=await register();
  assert.equal((await call('/token','POST',{...good,deviceId:other.token.deviceId})).status,401);
  const expired=(await call('/challenge','POST',{deviceId:device.token.deviceId})).body;
  db.prepare('UPDATE cloud_windows_challenges SET expires_at=0 WHERE id=?').run(expired.challengeId);
  assert.equal((await call('/token','POST',await device.sign(expired))).body.code,'proof_expired_or_used');
  const limited=await register();
  for(let n=0;n<8;n++)assert.equal((await call('/challenge','POST',{deviceId:limited.token.deviceId})).status,200);
  assert.equal((await call('/challenge','POST',{deviceId:limited.token.deviceId})).status,429,'outstanding nonce storage is bounded');
  const capped=await register();const cap=(await call('/challenge','POST',{deviceId:capped.token.deviceId})).body;
  const wrong=await capped.sign({...cap,scopeHash:'0'.repeat(64)});
  for(let n=0;n<5;n++)assert.equal((await call('/token','POST',wrong)).status,401);
  assert.equal((await call('/token','POST',await capped.sign(cap))).status,429,'a challenge has a bounded signature verification budget');
});
test('transient failures keep the grant, but authority changes or RSA key changes revoke it permanently',async()=>{
  const device=await register();
  unavailable=true;
  assert.equal((await call('/keys','GET',undefined,device.authorization)).status,503);
  unavailable=false;
  assert.equal((await call('/keys','GET',undefined,device.authorization)).status,200);
  generation='c'.repeat(64);
  assert.equal((await call('/keys','GET',undefined,device.authorization)).body.code,'device_revoked');
  generation='a'.repeat(64);
  assert.equal((await call('/challenge','POST',{deviceId:device.token.deviceId})).body.code,'device_revoked');
  const other=await register();const original=rsaPublic;rsaPublic={...rsaPublic,n:rsaPublic.n.slice(1)};
  assert.equal((await call('/keys','GET',undefined,other.authorization)).body.code,'device_revoked');rsaPublic=original;
  const third=await register();
  assert.equal((await call('/revoke','POST',{},third.authorization)).status,200);
  assert.equal((await call('/challenge','POST',{deviceId:third.token.deviceId})).status,401);
});
test('catalog snapshots catch concurrent changes and preserve scope after parent moves; absence is not a tombstone',async()=>{
  const device=await register();
  const start=(await call('/catalog/start','GET',undefined,device.authorization)).body;
  const query=`?epoch=${start.epoch}&until=${start.cursor}`;
  const snapshot=await call('/catalog/snapshot'+query,'GET',undefined,device.authorization);
  assert.equal(snapshot.status,200,JSON.stringify(snapshot.body));
  assert.deepEqual(snapshot.body.items.filter(i=>i.kind==='file').map(i=>i.id),[1]);
  assert.deepEqual(snapshot.body.items.filter(i=>i.kind==='folder').map(i=>i.id).sort(),[7,8]);
  assert.equal(JSON.stringify(snapshot.body).includes('objectKey'),false);
  db.exec("UPDATE cloud_files SET original_name='concurrent name' WHERE id=1");
  const changes=await call(`/catalog/changes?epoch=${start.epoch}&after=${start.cursor}`,'GET',undefined,device.authorization);
  assert.equal(changes.body.items.find(i=>i.id===1&&i.kind==='file').value.name,'concurrent name');
  db.exec('UPDATE cloud_files SET folder_id=8 WHERE id=1; UPDATE cloud_folders SET parent_id=9 WHERE id=8');
  const moved=await call(`/catalog/snapshot?epoch=${start.epoch}`,'GET',undefined,device.authorization);
  assert.equal(moved.body.items.some(i=>i.id===1&&i.kind==='file'),false,'current ancestor scope wins over the stored old chain');
  assert.equal(moved.body.items.some(i=>i.state==='trashed'),false,'leaving a scope is never an instruction to delete local plaintext');
  db.exec("UPDATE cloud_folders SET parent_id=7 WHERE id=8; UPDATE cloud_files SET folder_id=7,original_name='own.txt' WHERE id=1");
  assert.equal((await call('/catalog/snapshot?epoch=wrong','GET',undefined,device.authorization)).body.code,'catalog_reset');
});

test('Windows content pins the first range to metadata and the captured object, and verified Web trash emits explicit tombstones',async()=>{
  const device=await register();
  const originalGet=env.FILES.get;
  db.exec('UPDATE cloud_files SET encrypted_size_bytes=65 WHERE id=1');
  let revision=db.prepare("SELECT seq FROM cloud_windows_heads WHERE kind='file' AND entity_id=1").get().seq;
  const content=async expected=>context.worker.fetch(new Request('https://tanaka-note.com/cloud/api/windows-sync/content/1',{
    headers:{...device.authorization,Range:'bytes=0-32','X-TCloud-Revision':String(expected)}}),env,{waitUntil(){}});
  env.FILES.get=async(key,options)=>{
    assert.equal(key,'own','the checked immutable body pointer is captured before fetching');
    assert.deepEqual(options.range,{offset:0,length:33});
    db.exec("UPDATE cloud_files SET object_key='new-version' WHERE id=1");
    return {size:65,range:{offset:0,length:33},httpEtag:'"original"',body:new Uint8Array(33)};
  };
  try {
    const response=await content(revision);assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,33);
    const stale=await content(revision);assert.equal(stale.status,409);assert.equal((await stale.json()).code,'revision_changed');
    assert.equal((await call('/data/files/1/download','GET',undefined,device.authorization)).status,403,'no unpinned native body path');
  } finally {env.FILES.get=originalGet;db.exec("UPDATE cloud_files SET object_key='own',encrypted_size_bytes=NULL WHERE id=1");}
  const admin=await handoff('admin');
  const before=(await call('/catalog/start','GET',undefined,device.authorization)).body;
  assert.equal((await api(admin.cookie,'/files/1','DELETE',undefined,{'X-TCloud-Session':admin.body.sessionCacheId})).status,200);
  const deleted=await call(`/catalog/changes?epoch=${before.epoch}&after=${before.cursor}`,'GET',undefined,device.authorization);
  const tombstone=deleted.body.items.find(i=>i.kind==='file'&&i.id===1);
  assert.equal(tombstone.state,'trashed');assert.ok(tombstone.trashOperationId);assert.ok(tombstone.deletedAt);
  assert.equal(tombstone.value,undefined,'trash feed discloses no old key or encrypted metadata');
  assert.throws(()=>db.exec('DELETE FROM cloud_files WHERE id=1'),/trash_purge_not_confirmed/);
  assert.equal(db.prepare("SELECT seq FROM cloud_windows_heads WHERE kind='file' AND entity_id=1").get().seq,tombstone.revision,
    'an aborted physical deletion rolls back its proposed tombstone');
  assert.equal((await content(tombstone.revision)).status,404,'trash cannot be downloaded through an old device body reference');
  assert.equal((await api(admin.cookie,'/files/1/restore','POST',{}, {'X-TCloud-Session':admin.body.sessionCacheId})).status,200);
  const restored=await call(`/catalog/changes?epoch=${before.epoch}&after=${tombstone.revision}`,'GET',undefined,device.authorization);
  assert.equal(restored.body.items.find(i=>i.kind==='file'&&i.id===1).state,'present');
});

test('catalog pagination advances over hidden rows without losing allowed originals',async()=>{
  const device=await register();
  const insert=db.prepare("INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by) VALUES(?,7,?,'fixture.txt','text/plain','document',1,'ready','member')");
  try {
    for(let i=0;i<205;i++)insert.run(10000+i,'catalog-fixture-'+i);
    const start=(await call('/catalog/start','GET',undefined,device.authorization)).body;
    let next=0,complete=false;const files=[];
    while(!complete) {
      const result=await call(`/catalog/snapshot?epoch=${start.epoch}&until=${start.cursor}&after=${next}`,'GET',undefined,device.authorization);
      assert.equal(result.status,200);assert.ok(result.body.next>next);next=result.body.next;complete=result.body.complete;
      files.push(...result.body.items.filter(i=>i.kind==='file').map(i=>i.id));
    }
    assert.equal(files.length,206);assert.equal(new Set(files).size,206);assert.ok(!files.includes(2)&&!files.includes(3)&&!files.includes(4));
  } finally {db.exec('DELETE FROM cloud_files WHERE id BETWEEN 10000 AND 10204');}
});

test('feature-off is closed and native routes never authorize passkey, crypto setup, sharing or trash changes',async()=>{
  env.WINDOWS_SYNC_ENABLED='false';
  assert.equal((await call('/challenge','POST',{})).status,503);env.WINDOWS_SYNC_ENABLED='true';
  for(const route of ['/api/crypto-setup','/api/session','/api/passkey/handoff','/api/shares','/api/files/1/permanent'])
    for(const method of ['GET','POST','PUT','PATCH','DELETE'])assert.equal(windowsDataRoute(route,method),false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cloud_files').get().n,4,'no fixture original changed');
  db.close();securityDb.close();
});
