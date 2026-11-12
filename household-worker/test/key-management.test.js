import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {bundle,d1,fixture,household} from './fixture.js';
import {createClientVault,wrapMaster,unwrapMaster,unlockClient,keyScope} from '../public/household-crypto.mjs';
const security=await bundle(new URL('../../security-worker/src/index.js',import.meta.url),'\nexport {securitySessionHeaders,signedCookie};');

test('Security HTTP provisioning authenticates both sessions, requires fresh primary-admin approval, resolves the household from live links, and refuses revoked credentials',async()=>{
  const f=fixture(),db=new DatabaseSync(':memory:');const master=crypto.getRandomValues(new Uint8Array(32)),prf=crypto.getRandomValues(new Uint8Array(32));
  try{
    const dir=new URL('../../security-worker/migrations/',import.meta.url);
    for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(name,dir),'utf8'));
    db.exec("INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture admin','active',1),('subject','Fixture viewer','active',0); INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('fixture-admin-AA','primary-admin','AQI','YWJj','active'),('fixture-viewer-AA','subject','AQI','YWJj','active'); INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('owner-link','primary-admin','household','owner','Fixture owner','active'),('viewer-link','subject','household','viewer','Fixture viewer','active'),('independent-link','subject','household','chiharu-admin','Fixture independent','active')");
    const recovery=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
    const pub=await crypto.subtle.exportKey('jwk',recovery.publicKey);
    const env={DB:d1(db),SESSION_SECRET:randomBytes(32).toString('hex'),PASSKEY_ENABLED:'true',HOUSEHOLD_AUTH:new household.SecurityIntegration({},f.env),CLOUD_AUTH:{getPrimaryAdminCryptoConfig:async()=>({initialized:true,publicKeyJwk:pub})}};
    const worker=new security.default({},env);
    const cookies=async(identityId,credentialId,admin)=>{const h=await security.securitySessionHeaders(env,new URL('https://example.test'),identityId,credentialId,admin);return h.getSetCookie().map(c=>c.split(';')[0]).join('; ');};
    const admin=await cookies('primary-admin','fixture-admin-AA',true),viewer=await cookies('subject','fixture-viewer-AA',false);
    const request=(path,value,cookie=admin,origin='https://example.test')=>worker.fetch(new Request(`https://example.test/security/api/household${path}`,{method:value===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})}));
    assert.equal((await request('/own',undefined,'')).status,401);
    const vault=await createClientVault(prf);
    assert.equal((await request('/vault',vault,viewer,'https://evil.test')).status,403);
    assert.equal((await request('/vault',vault,viewer)).status,200);
    assert.equal((await request('/vault',vault,viewer)).status,200);
    const keyId=crypto.randomUUID(),config={householdId:'main',keyId},recoveryWrappedKey=await wrapMaster(master,pub,keyScope(config));
    const initialize={serviceLinkId:'viewer-link',keyId,recoveryWrappedKey};
    assert.equal((await request('/initialize',initialize,viewer)).status,401);
    const old={kind:'identity',identityId:'primary-admin',credentialId:'fixture-admin-AA',authMethod:'passkey',authenticatedAt:Math.floor(Date.now()/1000)-301,passkeySessionEpoch:1};
    const oldIdentity=await security.signedCookie(env,'troom_security_identity',old,43200,true),oldAdmin=await security.signedCookie(env,'troom_security_admin',{...old,kind:'admin'},43200,true);
    assert.equal((await request('/initialize',initialize,`${oldIdentity.split(';')[0]}; ${oldAdmin.split(';')[0]}`)).status,428);
    assert.equal((await request('/initialize',initialize)).status,200);
    assert.equal(f.sqlite.prepare("SELECT household_id FROM household_crypto_config").get().household_id,'main');
    const grant={serviceLinkId:'viewer-link',credentialId:'fixture-viewer-AA',keyId,wrappedKey:await wrapMaster(master,vault.publicKey,keyScope(config))};
    assert.equal((await request('/grant',grant)).status,200);
    const own=await (await request('/own',undefined,viewer)).json();assert.equal(own.prepared,true);assert.equal(own.targets.find(t=>t.serviceLinkId==='viewer-link').ready,true);assert.equal(own.targets.find(t=>t.serviceLinkId==='independent-link').ready,false);
    const row=f.sqlite.prepare('SELECT wrapped_key FROM household_crypto_grants').get();assert.deepEqual(await unwrapMaster(await unlockClient(prf,vault),row.wrapped_key,keyScope(config)),master);
    assert.equal((await request('/grant',{...grant,serviceLinkId:'independent-link'})).status,409,'main key cannot be granted to the independent household');
    db.exec("UPDATE security_credentials SET status='revoked' WHERE credential_id='fixture-viewer-AA'");
    assert.equal((await request('/own',undefined,viewer)).status,401);assert.equal((await request('/grant',grant)).status,403);
    db.exec("UPDATE security_credentials SET status='active' WHERE credential_id='fixture-viewer-AA'; UPDATE security_service_links SET status='disabled' WHERE id='viewer-link'");
    assert.equal((await request('/grant',grant)).status,403);
  }finally{master.fill(0);prf.fill(0);db.close();f.close();}
});
