import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { randomBytes,createHmac } from 'node:crypto';
import { createVault } from '../../e2ee/crypto.mjs';
import { prepareKeyConfiguration } from '../../e2ee/setup.mjs';
import { diaryRecipientId,handleDiaryKeys,diaryKeyBundle } from '../../../security-worker/src/diary-keys.js';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkerEntrypoint {}',shortCircuit:true};return next(specifier,context);}});
const {default:worker,SecurityIntegration}=await import('../../src/index.js');
function database(service) {
  const sqlite=new DatabaseSync(':memory:');
  const dir=new URL(`../../../${service}-worker/migrations/`,import.meta.url);
  for(const name of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
  const schema=service==='diary'?new URL('../../e2ee/schema.sql',import.meta.url):new URL('../../../security-worker/e2ee/diary-keys.sql',import.meta.url);
  sqlite.exec(readFileSync(schema,'utf8'));
  const prepare=(sql,args=[])=>({bind:(...values)=>prepare(sql,values),first:async()=>sqlite.prepare(sql).get(...args)||null,all:async()=>({results:sqlite.prepare(sql).all(...args)}),run:async()=>({meta:sqlite.prepare(sql).run(...args)}),execute:()=>{const statement=sqlite.prepare(sql);return statement.columns().length?{results:statement.all(...args)}:{meta:statement.run(...args)};}});
  return {sqlite,prepare,batch:async statements=>{sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},close:()=>sqlite.close()};
}
export async function systemFixture({recoveryBits=3072,recoveryExtractable=false}={}) {
  const db=database('diary'),central=database('security'),r2=new Map(),wire=[],pending=[];
  const env={DB:db,SESSION_SECRET:randomBytes(32).toString('base64url'),SESSION_VERSION:'3',PASSKEY_ENABLED:'true',DIARY_ENCRYPTION_ENABLED:'true',DIARY_ENCRYPTION_ORIGIN:'http://127.0.0.1:8791',DIARY_ENCRYPTION_LOCAL_TEST:'true'};
  const integration=new SecurityIntegration();integration.env=env;
  const recovery=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:recoveryBits,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},recoveryExtractable,['encrypt','decrypt']);
  const recoveryPublicKey=await crypto.subtle.exportKey('jwk',recovery.publicKey);
  const centralEnv={DB:central,DIARY_ENCRYPTION_ENABLED:'true',DIARY_AUTH:integration,CLOUD_AUTH:{getPrimaryAdminCryptoConfig:async()=>({initialized:true,publicKeyJwk:recoveryPublicKey})}};
  const people=[{identityId:'primary-admin',credentialId:'fixture-primary-credential',accounts:['main-admin','main-user']},{identityId:'fixture-editor',credentialId:'fixture-editor-credential',accounts:['wife-admin']},{identityId:'fixture-other-house',credentialId:'fixture-other-credential',accounts:['chiharu-admin']}];
  const users={},members=[];
  const json=(value,status=200)=>Response.json(value,{status});
  const helpers={json,readJson:request=>request.json(),audit:async()=>{}};
  for(const person of people) {
    central.sqlite.prepare("INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES(?,?,'active',?)").run(person.identityId,'Synthetic identity',person.identityId==='primary-admin'?1:0);
    central.sqlite.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES(?,?,'public-fixture','salt-fixture','active',1)").run(person.credentialId,person.identityId);
    const prf=crypto.getRandomValues(new Uint8Array(32));
    for(const accountId of person.accounts) {
      const link=`fixture-link-${accountId}`;
      central.sqlite.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES(?,?,'diary',?,'Synthetic diary','active')").run(link,person.identityId,accountId);
      const recipientId=await diaryRecipientId(person.credentialId,link),vault=await createVault(prf,recipientId),claims=await integration.describeEncryptionAccount({accountId});
      users[accountId]={...person,serviceLinkId:link,serviceAccountId:accountId,recipientId,prf,claims,vault,active:true};
      const response=await handleDiaryKeys('/api/diary/vault',new Request('https://fixture.test/security/api/diary/vault',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serviceLinkId:link,vault})}),centralEnv,{...person,authenticatedAt:Date.now()/1000},helpers);
      if(response.status!==200)throw new Error('FixtureVaultFailure');
      members.push({...claims,identityId:person.identityId,credentialId:recipientId,webAuthnCredentialId:person.credentialId,serviceLinkId:link,publicKey:vault.publicKey,signPublicKey:vault.signPublicKey});
    }
  }
  const configuration=await prepareKeyConfiguration({status:{members,households:await integration.encryptionHouseholds(),config:null,recoveryPublicKey},recoveryPrivateKey:recovery.privateKey});
  await handleDiaryKeys('/api/diary/config',new Request('https://fixture.test/security/api/diary/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(configuration)}),centralEnv,{identityId:'primary-admin',credentialId:people[0].credentialId,authenticatedAt:Date.now()/1000},helpers);
  db.sqlite.exec("UPDATE diary_e2ee_control SET phase='encrypted',generation=1,ever_encrypted=1");
  env.MEDIA={put:async(key,body,metadata)=>{r2.set(key,{bytes:new Uint8Array(await new Response(body).arrayBuffer()),metadata});},get:async key=>{const value=r2.get(key);return value?{body:new Blob([value.bytes]).stream()}:null;},delete:async key=>{r2.delete(key);}};
  env.SECURITY={getDiaryKeyBundle:input=>diaryKeyBundle(centralEnv,input),validatePasskeySession:async input=>({valid:users[input.serviceAccountId]?.active===true}),passkeyRollingSession:async input=>({valid:users[input.serviceAccountId]?.active!==false,expiresAt:Math.floor(Date.now()/1000)+43200}),recordAuditEvent:async()=>({stored:true}),redeemHandoff:async token=>{const user=users[token];return user?{identityId:user.identityId,credentialId:user.credentialId,serviceLinkId:user.serviceLinkId,serviceAccountId:user.serviceAccountId,sessionEpoch:1}:null;}};
  function cookie(accountId='main-admin',user=users[accountId]) {
    const payload={accountId,role:user.claims.isGlobalOwner||accountId!=='main-user'?'admin':'user',version:'3',accountVersion:db.sqlite.prepare('SELECT session_version FROM diary_accounts WHERE id=?').get(accountId)?.session_version||1,authMethod:'passkey',exp:Math.floor(Date.now()/1000)+3600,startedAt:new Date().toISOString(),identityId:user.identityId,credentialId:user.credentialId,serviceLinkId:user.serviceLinkId,serviceAccountId:accountId,passkeySessionEpoch:1};
    const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');return `troom_diary_session=${encoded}.${createHmac('sha256',env.SESSION_SECRET).update(encoded).digest('base64url')}`;
  }
  return {worker,env,db,central,centralEnv,integration,configuration,recovery,people,users,r2,wire,helpers,cookie,ctx:{waitUntil:value=>pending.push(value)},async close(){await Promise.allSettled(pending);for(const person of Object.values(users))person.prf.fill(0);db.close();central.close();}};
}
