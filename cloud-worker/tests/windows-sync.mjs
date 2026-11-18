import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWindowsSync, cleanupWindowsSync, deviceChallengeMessage, windowsDataRoute } from '../src/windows-sync.js';
import { db, env, context, api, handoff, securityDb } from './session-fixture.mjs';

context.handleWindowsSync=handleWindowsSync; context.cleanupWindowsSync=cleanupWindowsSync;
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
async function register() {
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
  assert.equal((await call('/data/folders/8','PATCH',{name:'renamed child',passwordAction:'keep'},device.authorization)).status,200,'ordinary folder rename still works');
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
test('concurrent proofs consume exactly once; tampering cannot enlarge scope or change the device',async()=>{
  const device=await register();
  const challenge=(await call('/challenge','POST',{deviceId:device.token.deviceId})).body;
  const bad=await device.sign({...challenge,scopeHash:'b'.repeat(64)});
  assert.equal((await call('/token','POST',bad)).status,401);
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
test('feature-off is closed and native routes never authorize passkey, crypto setup, sharing or trash changes',async()=>{
  env.WINDOWS_SYNC_ENABLED='false';
  assert.equal((await call('/challenge','POST',{})).status,503);env.WINDOWS_SYNC_ENABLED='true';
  for(const route of ['/api/crypto-setup','/api/session','/api/passkey/handoff','/api/shares','/api/files/1/permanent'])
    for(const method of ['GET','POST','PUT','PATCH','DELETE'])assert.equal(windowsDataRoute(route,method),false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cloud_files').get().n,4,'no fixture original changed');
  db.close();securityDb.close();
});
