import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {systemFixture} from '../../diary-worker/tests/e2ee/system-fixture.mjs';
import {createVault} from '../../diary-worker/e2ee/crypto.mjs';
import {prepareKeyConfiguration} from '../../diary-worker/e2ee/setup.mjs';
import {diaryApprovalTargets,diaryKeyBundle,diaryRecipientId,handleDiaryKeys} from '../src/diary-keys.js';

let f;
before(async()=>{
  f=await systemFixture();
  // A fifth approved recipient exercises the concurrency bound and next wave.
  const credentialId='fixture-extra-credential',user=f.users['main-user'];
  f.central.sqlite.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES(?,'primary-admin','public-fixture','salt-fixture','active',1)").run(credentialId);
  const recipientId=await diaryRecipientId(credentialId,user.serviceLinkId),prf=crypto.getRandomValues(new Uint8Array(32));
  try {
    const vault=await createVault(prf,recipientId);
    const actor={identityId:'primary-admin',credentialId,authenticatedAt:Date.now()/1000};
    const response=await central('/vault',{serviceLinkId:user.serviceLinkId,vault},actor);
    assert.equal(response.status,200);
    const status=await (await central('/admin')).json();
    const configuration=await prepareKeyConfiguration({status,recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor});
    assert.equal((await central('/config',configuration)).status,200);
    f.configuration=configuration;
  }finally{prf.fill(0);}
});
after(async()=>{await f?.close();});

function central(path,body,actor=f.users['main-admin'],approval) {
  return handleDiaryKeys('/api/diary'+path,new Request('https://fixture.test/security/api/diary'+path,{
    method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})
  }),f.centralEnv,{...actor,authenticatedAt:Date.now()/1000},{...f.helpers,approval});
}
const bundle=(account='main-user')=>diaryKeyBundle(f.centralEnv,f.users[account]);

test('Diary-only pending recipient receives signed grants only when approval commits',async()=>{
  const {identityId,serviceLinkId,serviceAccountId}=f.users['wife-admin'];
  const credentialId='diary-only-pending',recipientId=await diaryRecipientId(credentialId,serviceLinkId);
  const target={identityId,credentialId,serviceLinkId,serviceAccountId};
  const prf=crypto.getRandomValues(new Uint8Array(32));
  const {sqlite}=f.central;
  sqlite.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES(?,?,'fixture','salt','pending',1)").run(credentialId,identityId);
  try {
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM security_service_links WHERE identity_id=? AND service='cloud'").get(identityId).n,0);
    const links=await diaryApprovalTargets(f.centralEnv,identityId,credentialId);
    const vault=await createVault(prf,recipientId);
    await central('/vault',{serviceLinkId,vault},target,{links,preparation:true});
    const source=f.users['main-admin'],approval={identityId,credentialId,links,eventId:'fixture-diary-approval'};
    const status=await (await central('/admin',undefined,source,approval)).json();
    const configuration=await prepareKeyConfiguration({status,recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor});
    const prepared=await central('/config',configuration,source,approval);
    await f.central.batch(prepared.statements);
    assert.equal(await diaryKeyBundle(f.centralEnv,target),null);
    assert.equal((await bundle()).generation,f.configuration.directory.value.generation);
    await f.central.batch([
      f.central.prepare("UPDATE security_credentials SET status='active' WHERE credential_id=?").bind(credentialId),
      f.central.prepare(`INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,identity_id,auth_method,details_json)
        VALUES(?,CURRENT_TIMESTAMP,'security','identity_approved','success',?,'passkey','{}')`).bind(approval.eventId,identityId),
      ...prepared.statements
    ]);
    const result=await diaryKeyBundle(f.centralEnv,target);
    assert.equal(result.recipientId,recipientId);
    assert.ok(result.grants.length);
    assert.equal(result.rekeyRequired,false);
    f.central.sqlite.prepare('DELETE FROM security_diary_key_grants WHERE generation=?').run(configuration.directory.value.generation);
    sqlite.prepare('UPDATE security_diary_key_config SET generation=?,directory_json=?,recovery_json=? WHERE id=1')
      .run(f.configuration.directory.value.generation,JSON.stringify(f.configuration.directory),JSON.stringify(f.configuration.recoveryEnvelope));
  } finally {
    sqlite.prepare('DELETE FROM security_credentials WHERE credential_id=?').run(credentialId);
    prf.fill(0);
  }
});
async function ready(promise) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Permission checks did not progress')),3000);})]);}
  finally{clearTimeout(timer);}
}

test('Diary permission RPCs overlap up to four, and no bundle returns before the final recipient settles',async()=>{
  const expected=await bundle(),native=f.integration.describeEncryptionAccount.bind(f.integration);
  const first=Promise.withResolvers(),last=Promise.withResolvers(),started=Promise.withResolvers(),lastStarted=Promise.withResolvers();
  let active=0,peak=0,settled=false;const calls=[];
  f.integration.describeEncryptionAccount=async input=>{
    const index=calls.push(input.accountId)-1;peak=Math.max(peak,++active);
    if(calls.length===4)started.resolve();
    if(index===4)lastStarted.resolve();
    try{await (index<4?first.promise:last.promise);return await native(input);}
    finally{active--;}
  };
  const pending=bundle().finally(()=>{settled=true;});
  try {
    await ready(started.promise);
    assert.equal(calls.length,4);assert.equal(peak,4);assert.equal(settled,false);
    first.resolve();await ready(lastStarted.promise);await new Promise(setImmediate);
    assert.equal(calls.length,5);assert.equal(settled,false,'the fifth live check gates the response');
    last.resolve();assert.deepEqual(await pending,expected);
    assert.equal(active,0);assert.equal(peak,4);
    assert.deepEqual(calls.sort(),f.configuration.directory.value.members.map(member=>member.accountId).sort());
  }finally{first.resolve();last.resolve();await pending;f.integration.describeEncryptionAccount=native;}
});

test('credential, Identity and link revocation are read again on each bundle request',async()=>{
  const changes=[
    ["UPDATE security_credentials SET status='revoked' WHERE credential_id='fixture-editor-credential'",true],
    ["UPDATE security_identities SET status='disabled' WHERE id='fixture-editor'",true],
    ["UPDATE security_service_links SET status='disabled' WHERE id='fixture-link-wife-admin'",true],
    ["UPDATE security_credentials SET status='revoked' WHERE credential_id='fixture-primary-credential'",null],
    ["UPDATE security_identities SET status='disabled' WHERE id='primary-admin'",null],
    ["UPDATE security_service_links SET status='disabled' WHERE id='fixture-link-main-user'",null]
  ];
  for(const [sql,expected] of changes) {
    assert.equal((await bundle()).rekeyRequired,false);
    f.central.sqlite.exec('SAVEPOINT bundle_revocation');
    try{f.central.sqlite.exec(sql);assert.equal((await bundle())?.rekeyRequired??null,expected);}
    finally{f.central.sqlite.exec('ROLLBACK TO bundle_revocation; RELEASE bundle_revocation');}
    assert.equal((await bundle()).rekeyRequired,false);
  }
});

test('reduced permissions, wrong account responses and unavailable recipients still require rekeying',async()=>{
  const native=f.integration.describeEncryptionAccount.bind(f.integration);
  const changes=[
    claims=>({...claims,canManageEntries:false}),
    claims=>({...claims,households:['chiharu-household']}),
    claims=>({...claims,canViewTrash:false}),
    claims=>({...claims,active:false}),
    claims=>({...claims,accountId:'different-account'}),
    ()=>null,
    ()=>{throw new Error('Synthetic provider unavailable');}
  ];
  try {
    for(const change of changes) {
      const calls=[];
      f.integration.describeEncryptionAccount=async input=>{
        calls.push(input.accountId);const claims=await native(input);
        return input.accountId==='wife-admin'?change(claims):claims;
      };
      assert.equal((await bundle()).rekeyRequired,true);
      assert.equal(calls.length,5,'a failed recipient does not skip other live checks');
    }
  }finally{f.integration.describeEncryptionAccount=native;}
  assert.equal((await bundle()).rekeyRequired,false);
});

test('admin/member bundle bindings, directory signatures and household-provider failures remain enforced',async()=>{
  for(const account of ['main-admin','main-user']) {
    const user=f.users[account],result=await bundle(account);
    assert.equal(result.accountId,account);assert.equal(result.recipientId,user.recipientId);
    assert.equal(result.webAuthnCredentialId,user.credentialId);assert.equal(result.serviceLinkId,user.serviceLinkId);
    assert.equal(result.rekeyRequired,false);
    const saved=f.central.sqlite.prepare('SELECT vault_json,grants_json,record_grants_json FROM security_diary_key_vaults v JOIN security_diary_key_grants g USING(recipient_id,service_link_id) WHERE v.recipient_id=? AND g.generation=?').get(user.recipientId,result.generation);
    assert.deepEqual(result.vault,JSON.parse(saved.vault_json));assert.deepEqual(result.grants,JSON.parse(saved.grants_json));assert.deepEqual(result.recordGrants,JSON.parse(saved.record_grants_json));
  }
  assert.equal(await diaryKeyBundle(f.centralEnv,{...f.users['main-user'],serviceAccountId:'main-admin'}),null);
  const stored=f.central.sqlite.prepare('SELECT directory_json FROM security_diary_key_config').get().directory_json;
  const changed=JSON.parse(stored);changed.value.members[0].canManageEntries=!changed.value.members[0].canManageEntries;
  f.central.sqlite.prepare('UPDATE security_diary_key_config SET directory_json=?').run(JSON.stringify(changed));
  try{await assert.rejects(bundle(),/Signature/);}
  finally{f.central.sqlite.prepare('UPDATE security_diary_key_config SET directory_json=?').run(stored);}
  const households=f.integration.encryptionHouseholds.bind(f.integration);
  f.integration.encryptionHouseholds=async()=>{throw new Error('Synthetic households unavailable');};
  try{await assert.rejects(bundle(),/Synthetic households unavailable/);}
  finally{f.integration.encryptionHouseholds=households;}
});
