import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sealTrust,openTrust,resolveTrust} from '../../e2ee/trust.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';
import {prepareDiaryKeys} from '../../public/diary-key-preparation.js';
import {diaryLoginTrust,diaryRecipientId,handleDiaryKeys,diaryKeyBundle} from '../../../security-worker/src/diary-keys.js';
import {createVault} from '../../e2ee/crypto.mjs';
import {unlockCentralRecovery} from '../../e2ee/tcloud-recovery.mjs';
import '../../../cloud-worker/public/crypto-vault.js';
import {systemFixture} from './system-fixture.mjs';

test('passkey-protected trust survives device changes and rejects corruption, credential substitution, authority change and rollback',async()=>{
  const f=await systemFixture(),u=f.users['main-user'],trust=await publicTrustPackage(f.configuration);
  try {
    const packet=await sealTrust(u.prf,u.recipientId,trust);
    assert.deepEqual(await openTrust(u.prf,u.recipientId,packet),trust);
    assert.deepEqual(await resolveTrust({prf:u.prf,recipientId:u.recipientId,sealed:packet}),trust);
    await assert.rejects(openTrust(f.users['wife-admin'].prf,u.recipientId,packet));
    await assert.rejects(openTrust(u.prf,f.users['main-admin'].recipientId,packet));
    const corrupted=structuredClone(packet);corrupted.envelope.iv=corrupted.envelope.iv.replace(/^./,corrupted.envelope.iv[0]==='A'?'B':'A');
    await assert.rejects(resolveTrust({prf:u.prf,recipientId:u.recipientId,sealed:corrupted,bootstrap:trust}));
    await assert.rejects(resolveTrust({prf:u.prf,recipientId:u.recipientId,sealed:packet,pinned:{...trust,minimumGeneration:2}}),/Rollback/);
    const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
    const changed=await publicTrustPackage({...f.configuration,anchor:await crypto.subtle.exportKey('jwk',other.publicKey)});
    await assert.rejects(resolveTrust({prf:u.prf,recipientId:u.recipientId,sealed:packet,bootstrap:changed}),/TrustChanged/);
    assert.equal(JSON.stringify(packet).includes('anchor'),false);
  }finally{await f.close();}
});

test('authenticated Security handoff bootstraps trust once; subsequent normal logins open the sealed pin without JSON',async()=>{
  const f=await systemFixture({phase:'legacy'}),u=f.users['main-user'],wire=[];
  let lose=true;
  const api=async(path,options={})=>{
    wire.push(options.body||{});
    const method=options.method||'GET';
    const response=await f.worker.fetch(new Request('https://tanaka-note.com/diary/api'+path,{method,headers:{Cookie:f.cookie('main-user'),Origin:'https://tanaka-note.com','Content-Type':'application/json','X-Diary-Request':'1'},...(options.body?{body:JSON.stringify(options.body)}:{})}),f.env,f.ctx);
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});
    if(options.body?.trust&&lose){lose=false;throw new Error('SyntheticResponseLoss');}return result;
  };
  try {
    const trust=await diaryLoginTrust(f.centralEnv,u.identityId,u.credentialId);
    const authentication={credentialId:u.credentialId,prfOutput:new Uint8Array(u.prf),handoff:{diaryTrust:trust}},session={encryption:{accountId:'main-user'}};
    await assert.rejects(prepareDiaryKeys(api,session,authentication),/SyntheticResponseLoss/);
    const before=JSON.parse(f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(u.recipientId).vault_json);
    assert.ok(before.trust);
    await prepareDiaryKeys(api,session,{...authentication,handoff:{}});
    const after=JSON.parse(f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(u.recipientId).vault_json);
    assert.deepEqual(after,before);
    assert.equal(JSON.stringify(wire).includes(Buffer.from(u.prf).toString('base64url')),false);
    await assert.rejects(api('/encryption/manage/admin'),error=>error.status===403);
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(u.credentialId);
    assert.equal(await diaryLoginTrust(f.centralEnv,u.identityId,u.credentialId),null);
  }finally{await f.close();}
});

test('owner normal login reuses existing T-Cloud recovery, initializes and grants approved recipients without Security UI, and stops on revocation',async()=>{
  const f=await systemFixture({phase:'legacy',recoveryExtractable:true}),u=f.users['main-admin'];
  try {
    const context='T-ROOM Cloud Storage admin private key v1',accountKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const raw=new Uint8Array(await crypto.subtle.exportKey('pkcs8',f.recovery.privateKey)),iv=crypto.getRandomValues(new Uint8Array(12));
    let envelope;
    try{const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(context)},accountKey,raw);envelope=await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey,{adminPrivateCipher:Buffer.from(cipher).toString('base64url'),adminPrivateIv:Buffer.from(iv).toString('base64url')},u.prf);}finally{raw.fill(0);}
    assert.equal((await unlockCentralRecovery(u.prf,envelope)).extractable,false);
    f.central.sqlite.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES('synthetic-envelope','primary-admin',?,?,'admin_private_prf',?,?)").run(u.credentialId,u.serviceLinkId,envelope.encryptedPayload,envelope.payloadIv);
    f.central.sqlite.exec('DELETE FROM security_diary_key_grants;DELETE FROM security_diary_key_config;');
    const api=async(path,options={})=>{
      const response=await f.worker.fetch(new Request('https://tanaka-note.com/diary/api'+path,{method:options.method||'GET',headers:{Cookie:f.cookie('main-admin'),Origin:'https://tanaka-note.com','Content-Type':'application/json','X-Diary-Request':'1'},...(options.body?{body:JSON.stringify(options.body)}:{})}),f.env,f.ctx);
      const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});return result;
    };
    const session={isGlobalOwner:true,encryption:{accountId:'main-admin'}},auth={credentialId:u.credentialId,prfOutput:new Uint8Array(u.prf)};
    await prepareDiaryKeys(api,session,auth);
    assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,1);
    const trust=await diaryLoginTrust(f.centralEnv,u.identityId,u.credentialId);
    await prepareDiaryKeys(api,session,{...auth,handoff:{diaryTrust:trust}});
    assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,1,'ordinary logins do not churn key generations');
    const credentialId='fixture-new-approved-passkey',identityId='fixture-editor',serviceLinkId=f.users['wife-admin'].serviceLinkId;
    f.central.sqlite.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES(?,?,'synthetic','synthetic','active',1)").run(credentialId,identityId);
    const prf=crypto.getRandomValues(new Uint8Array(32)),recipientId=await diaryRecipientId(credentialId,serviceLinkId),vault=await createVault(prf,recipientId);
    await handleDiaryKeys('/api/diary/vault',new Request('https://fixture.test/security/api/diary/vault',{method:'POST',body:JSON.stringify({serviceLinkId,vault})}),f.centralEnv,{identityId,credentialId,authenticatedAt:Date.now()/1000},f.helpers);
    await prepareDiaryKeys(api,session,{...auth,handoff:{diaryTrust:trust}});
    assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,2);
    const bundle=await diaryKeyBundle(f.centralEnv,{identityId,credentialId,serviceLinkId,serviceAccountId:'wife-admin'});
    assert.ok(bundle.grants.length);assert.equal(bundle.accountId,'wife-admin');
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(credentialId);
    await assert.rejects(prepareDiaryKeys(api,session,{...auth,handoff:{diaryTrust:await diaryLoginTrust(f.centralEnv,u.identityId,u.credentialId)}}),error=>error.code==='RekeyRequired');
    assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,2);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'legacy');
    prf.fill(0);auth.prfOutput.fill(0);
  }finally{await f.close();}
});
