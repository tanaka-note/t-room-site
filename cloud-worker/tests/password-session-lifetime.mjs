import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHmac} from 'node:crypto';
import {context,env,db,api,handoff,legacyPasswordSession} from './session-fixture.mjs';
import {recordSecurityAudit} from '../../assets/security-audit-worker.js';

const audit=[];
context.recordSecurityAudit=recordSecurityAudit;
env.SECURITY.recordAuditEvent=async event=>{audit.push(event);return {stored:true};};
const before=JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all());
const loginCounters=JSON.stringify(db.prepare('SELECT * FROM cloud_login_attempts').all());
for(const role of ['admin','subadmin']) {
  for(const credentials of [{authProof:'local-proof'},{password:'local-proof'},{authProof:'wrong'}]) {
    const login=await api(null,'/login','POST',{loginId:role+'@test',...credentials});
    assert.equal(login.status,401);assert.equal(login.cookie,undefined);
    assert.equal(login.body.error,'T-Cloudはパスキーでログインしてください。');
    assert.equal(audit.at(-1).details.reason,'password_auth_disabled');
    assert.equal(audit.at(-1).details.counterUpdated,false);
  }
  const legacy=legacyPasswordSession(role);
  const sign=payload=>{const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');return 'troom_cloud_session='+encoded+'.'+createHmac('sha256',env.SESSION_SECRET).update(encoded).digest('base64url');};
  for(const authMethod of ['password',undefined,null]) {
    const cookie=sign({...legacy.payload,authMethod});
    assert.equal((await api(cookie,'/session')).body.authenticated,false);
    for(const route of ['/items','/favorites','/crypto-config'])assert.equal((await api(cookie,route)).status,401);
    assert.equal((await api(cookie,'/folders/7/unlock','POST',{password:'local-proof'})).status,401);
  }
  const logout=await api(legacy.cookie,'/logout','POST',{});
  assert.equal(logout.status,200);assert.ok(logout.cookie,'old PW cookie can be cleared without gaining authority');
}
assert.equal(JSON.stringify(db.prepare('SELECT * FROM cloud_login_attempts').all()),loginCounters);
for(const body of ['{malformed','',JSON.stringify({role:'admin'})]) {
  const response=await context.worker.fetch(new Request('https://example.test/cloud/api/login',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json'},body}),env,{waitUntil(){}});
  assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null);
}
assert.equal((await api(null,'/login','POST',{}, {Origin:'https://other.test'})).status,403);
const enabled=env.PASSKEY_ENABLED;env.PASSKEY_ENABLED='false';
assert.equal((await api(null,'/login','POST',{loginId:'admin@test',authProof:'local-proof'})).status,401);
env.PASSKEY_ENABLED=enabled;

// Both existing Cloud roles retain their exact passkey claims and scope.
for(const account of ['admin','folder-member']) {
  const login=await handoff(account);
  const payload=JSON.parse(Buffer.from(login.cookie.split('=')[1].split('.')[0],'base64url'));
  assert.equal(payload.authMethod,'passkey');assert.equal(payload.version,'5');assert.equal(payload.passkeySessionEpoch,1);
  assert.equal(payload.exp,Math.floor(Date.parse(payload.startedAt)/1000)+43200);
  assert.equal(payload.passwordSessionVersion,undefined);
  assert.equal((await api(login.cookie,'/session')).body.authenticated,true);
  assert.equal((await api(login.cookie,'/items', 'GET', undefined, {'X-TCloud-Session':login.body.sessionCacheId})).status,200);
  assert.equal(login.body.role,account==='admin'?'admin':'member');
}

// The unchanged Cloud Service Binding still serves Security's PW recovery,
// without opening a Cloud login or altering any credential/key records.
const integration=new context.SecurityIntegration();integration.env=env;
assert.equal((await integration.verifyPrimaryAdmin({loginId:env.ADMIN_LOGIN_ID,authProof:'local-proof'})).verified,true);
assert.equal((await integration.verifyPrimaryAdmin({loginId:env.SUBADMIN_LOGIN_ID,authProof:'local-proof'})).verified,false);
assert.equal((await integration.verifyPrimaryAdmin({loginId:env.ADMIN_LOGIN_ID,authProof:'wrong'})).verified,false);
const cryptoConfig=await integration.getPrimaryAdminCryptoConfig();
const record=await integration.getFolderCryptoRecord(7);
assert.equal((await api(null,'/auth-mode')).body.mode,'proof');
const securitySource=readFileSync(new URL('../../security-worker/src/index.js',import.meta.url),'utf8');
const start=securitySource.indexOf('async function bootstrapOptions('),end=securitySource.indexOf('async function bootstrapVerify(',start);
const recoveryAudit=[];
const recovery={PRIMARY_ADMIN_ID:'primary-admin',OWNER_DISPLAY_NAME:'owner',normalizeText:s=>String(s||'').trim(),normalizeSecretText:s=>String(s||''),
 readJson:async body=>body,enforceBootstrapAttemptLimit:async()=>{},ensurePrimaryAdminRecords:async()=>{},
 writeLocalAudit:async(_env,event)=>recoveryAudit.push(event),parseJson:JSON.parse,storeChallenge:async()=> 'fixture-challenge',
 registrationOptions:async(_env,id)=>{assert.equal(id,'primary-admin');return {challenge:'fixture'};},json:body=>body,
 HttpError:class extends Error {constructor(status,message){super(message);this.status=status;}}};
vm.runInNewContext(securitySource.slice(start,end),recovery);
const securityEnv={CLOUD_AUTH:integration,DB:{prepare:()=>({bind:()=>({all:async()=>({results:[]})})})}};
assert.equal((await recovery.bootstrapOptions({loginId:env.ADMIN_LOGIN_ID,authProof:'local-proof'},securityEnv)).challengeId,'fixture-challenge');
await assert.rejects(recovery.bootstrapOptions({loginId:env.ADMIN_LOGIN_ID,authProof:'wrong'},securityEnv),e=>e.status===401);
assert.ok(recoveryAudit.some(e=>e.eventType==='bootstrap_auth_success'));
assert.deepEqual(await integration.getPrimaryAdminCryptoConfig(),cryptoConfig);
assert.deepEqual(await integration.getFolderCryptoRecord(7),record);
assert.equal(JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()),before);
console.log('PASS Cloud PW login/cookie retirement, no counters/schema changes, preserved admin/member passkeys, Security bootstrap RPC and crypto providers');

// The real browser guard expires without a per-thumbnail session request.
let clock=100000,invalidations=0,fetches=0,callback;const local=new Map(),tab=new Map();
const store=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)});
const guard={fetch:async()=>{fetches++;return new Response('{}');},localStorage:store(local),sessionStorage:store(tab),Headers,URL,AbortController,ReadableStream,Response,Event,crypto,
 Date:{now:()=>clock},setTimeout:fn=>(callback=fn,1),clearTimeout(){callback=null;},addEventListener(){},dispatchEvent(){invalidations++;},location:{origin:'https://example.test',href:'https://example.test/cloud/',replace(){}},BroadcastChannel:class {postMessage(){}}};
guard.globalThis=guard;vm.runInNewContext(readFileSync(new URL('../public/session-guard.js',import.meta.url),'utf8'),guard);
guard.TCloudSession.bind({sessionCacheId:'authenticated',expiresAt:101,role:'admin'});
const pending=new AbortController();guard.TCloudSession.track(pending);
for(let i=0;i<100;i++)guard.TCloudSession.check();assert.equal(fetches,0);
clock=101000;callback();assert.equal(invalidations,1);assert.equal(pending.signal.aborted,true);assert.equal(guard.TCloudSession.context(),null);assert.equal(guard.TCloudSession.isBlocked(),true);
assert.match(readFileSync(new URL('../public/cloud.js',import.meta.url),'utf8'),/addEventListener\?\.\("tcloud-session-invalid", releaseSessionState\)/);
console.log('PASS local passkey expiry cleanup without per-thumbnail session traffic');
