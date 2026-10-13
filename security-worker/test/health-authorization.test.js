import test from 'node:test';
import assert from 'node:assert/strict';
import { healthSecurityFixture } from './health-security-fixture.mjs';
import { signSession } from '../../health-worker/src/worker.js';
import { recordId, encryptRecord, unlockClient, unwrapMaster } from '../../health-worker/public/health-crypto.mjs';

const origin='https://tanaka-note.com';
const request=(path,headers={},method='GET',body)=>new Request(origin+'/health/api'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
async function login(f,person='owner',overrides={}) {
  const response=await f.worker.fetch(request('/passkey/handoff',{},'POST',{handoffToken:f.issue(person,overrides),identityId:'fixture-third',person:'third'}));
  const value=await response.json();
  return {response,value,headers:{Cookie:response.headers.get('Set-Cookie')?.split(';')[0],'X-Health-Session':value.sessionId}};
}
const input=handoff=>({service:'health',...handoff,sessionEpoch:1});

test('real Security RPC derives both members from credentials, ignores client names and consumes handoffs once for the correct service',async()=>{
  const f=await healthSecurityFixture();try {
    for(const person of ['owner','subject']) {
      const result=await login(f,person);assert.equal(result.response.status,200);
      const vault=await unlockClient(f.health.users[person].prf,result.value.keyBundle.vault);
      const master=await unwrapMaster(vault,result.value.keyBundle.wrappedKey,'nobumi');assert.ok(Buffer.from(master).equals(f.health.master));master.fill(0);
      assert.equal((await f.worker.fetch(request('/records',result.headers))).status,200);
    }
    const identities=f.db.prepare("SELECT identity_id FROM security_audit_events WHERE service='health' AND event_type='passkey_login_success' ORDER BY rowid").all();
    assert.deepEqual(identities.map(row=>row.identity_id),['primary-admin','fixture-subject']);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM security_active_sessions WHERE service='health'").get().count,2);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM security_audit_events WHERE service='security'").get().count,0);
    const token=f.issue();assert.equal(await f.security.redeemHandoff(token,'diary'),null);
    const race=await Promise.all([f.security.redeemHandoff(token,'health'),f.security.redeemHandoff(token,'health')]);
    assert.equal(race.filter(Boolean).length,1);assert.equal(await f.security.redeemHandoff(token,'health'),null);
    assert.equal(await f.security.redeemHandoff(f.issue('owner',{sessionEpoch:0}),'health'),null);
    assert.equal(await f.security.redeemHandoff(f.issue('owner',{credentialId:'fixture-subject-AA'}),'health'),null);
    assert.equal(await f.security.redeemHandoff(f.issue('owner',{serviceLinkId:'link-subject'}),'health'),null);
    assert.equal((await login(f,'owner',{consumedAt:Math.floor(Date.now()/1000)})).response.status,401);
  }finally{f.close();}
});

test('real Identity/link/member/grant authorization fails closed for revocation, disabled state, mixed credentials, epoch and third parties',async()=>{
  const f=await healthSecurityFixture();try {
    const signed=async claims=>({Cookie:'troom_health_session='+await signSession({expiresAt:Math.floor(Date.now()/1000)+60,sessionVersion:'1',authMethod:'passkey',sessionId:'authorization-fixture',passkeySessionEpoch:1,...claims},f.health.env),'X-Health-Session':'authorization-fixture'});
    const owner=f.health.users.owner.handoff;
    const third={identityId:'fixture-third',credentialId:'fixture-third-AA',serviceLinkId:'third-link'};
    assert.equal((await f.security.validatePasskeySession({service:'diary',...third,serviceAccountId:'fixture-third',sessionEpoch:1})).valid,true);
    assert.equal(await f.security.redeemHandoff(f.issue('owner',third),'health'),null);
    const cases=[
      {label:'revoked credential',sql:"UPDATE security_credentials SET status='revoked' WHERE credential_id='fixture-owner-AA'"},
      {label:'disabled identity',sql:"UPDATE security_identities SET status='disabled' WHERE id='primary-admin'"},
      {label:'disabled link',sql:"UPDATE security_service_links SET status='disabled' WHERE id='link-owner'"},
      {label:'unapproved grant',sql:"DELETE FROM security_health_grants WHERE credential_id='fixture-owner-AA'",sessionValid:true},
      {label:'missing member',sql:"DELETE FROM security_health_members WHERE identity_id='primary-admin'",sessionValid:true},
      {label:'wrong credential',claims:{credentialId:'fixture-subject-AA'}},
      {label:'wrong link',claims:{serviceLinkId:'link-subject'}},
      {label:'wrong identity',claims:{identityId:'fixture-subject'}},
      {label:'old epoch',claims:{passkeySessionEpoch:0},keyAvailable:true},
      {label:'third party',claims:{identityId:'fixture-third',credentialId:'fixture-third-AA',serviceLinkId:'third-link'}},
      {label:'wrong service',claims:{service:'diary'},rpcOnly:true,keyAvailable:true},
    ];
    for(const item of cases) {
      f.db.exec('SAVEPOINT authorization_case');
      try {
        if(item.sql)f.db.exec(item.sql);
        const claims={...owner,...item.claims}, validation={...input(claims),sessionEpoch:claims.passkeySessionEpoch??1};
        assert.equal((await f.security.validatePasskeySession(validation)).valid,Boolean(item.sessionValid),item.label);
        if(!item.keyAvailable)assert.equal(await f.security.getHealthKeyBundle(validation),null,item.label);
        if(!item.rpcOnly)assert.equal((await f.worker.fetch(request('/records',await signed(claims)))).status,item.sessionValid?403:401,item.label);
        if(item.sql)assert.equal((await login(f)).response.status,item.sessionValid?403:401,item.label+' handoff');
      }finally{f.db.exec('ROLLBACK TO authorization_case; RELEASE authorization_case');}
    }
    assert.throws(()=>f.db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES ('third-health','fixture-third','health','nobumi','x','active')"));
    const result=await login(f);assert.equal((await f.worker.fetch(request('/records',{...result.headers,'X-Health-Session':'different-session'}))).status,409);
    f.security.env.PASSKEY_ENABLED='false';assert.equal((await f.worker.fetch(request('/records',result.headers))).status,401);
  }finally{f.close();}
});

test('Health HTTP, actual Security audits and failure logs contain encrypted envelopes without health plaintext or key material',async t=>{
  const f=await healthSecurityFixture();const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
  try {
    const {headers}=await login(f);const date='2004-06-07';
    const record={date,condition:'poor',symptoms:[{id:'headache',intensity:'strong'}],start:true,end:false,flow:'heavy',note:'HEALTH-PLAINTEXT-CANARY'};
    const id=await recordId(f.health.master,date,'nobumi'),encrypted=await encryptRecord(f.health.master,id,record,'nobumi');
    const payload={...encrypted,expectedRevision:0};assert.deepEqual(Object.keys(payload).sort(),['ciphertext','expectedRevision','iv']);
    const responses=[];
    responses.push(await (await f.worker.fetch(request('/records/'+id,headers,'PUT',payload))).json());
    const conflict=await f.worker.fetch(request('/records/'+id,headers,'PUT',payload));assert.equal(conflict.status,409);responses.push(await conflict.json());
    responses.push(await (await f.worker.fetch(request('/records',headers))).json());
    for(const extra of ['date','condition','symptoms','note','start','end','flow','cycleDays'])assert.equal((await f.worker.fetch(request('/records/'+id,headers,'PUT',{...payload,[extra]:record[extra]??28}))).status,400);
    const failing=()=>{throw new Error('HEALTH-PLAINTEXT-CANARY '+date+' '+Buffer.from(f.health.master).toString('base64url'));};
    const original=f.health.env.DB;f.health.env.DB={prepare:failing};
    const failed=await f.worker.fetch(request('/records',headers));assert.equal(failed.status,500);responses.push(await failed.json());f.health.env.DB=original;
    // Audit delivery failure must not log the exception message or block login.
    f.security.recordAuditEvent=failing;f.health.env.SECURITY_AUDIT={send:failing};assert.equal((await login(f)).response.status,200);
    await f.worker.fetch(request('/logout',headers,'POST',{}));
    const serialized=JSON.stringify({responses,logs,audits:f.db.prepare('SELECT * FROM security_audit_events').all()});
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM security_audit_events WHERE service='health'").get().count,1);
    for(const secret of [date,record.note,Buffer.from(f.health.master).toString('base64url'),...Object.values(f.health.users).map(user=>Buffer.from(user.prf).toString('base64url'))])assert.ok(!serialized.includes(secret));
    assert.doesNotMatch(serialized,/"(?:condition|symptoms|note|start|end|flow|cycleDays|prfOutput|privateKey|master)"/);
    assert.ok(logs.length>0);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});
