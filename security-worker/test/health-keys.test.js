import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { d1 } from '../../health-worker/test/fixture.js';
import { handleHealthKeys, healthKeyBundle, healthMembershipStatement, assertHealthMemberAvailable } from '../src/health-keys.js';
import { createClientVault, wrapMaster, unwrapMaster, unlockClient } from '../../health-worker/public/health-crypto.mjs';
class ErrorType extends Error { constructor(status,message){super(message);this.status=status;} }
function setup(){
  const db=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));db.exec('PRAGMA foreign_keys=ON');
  const DB=d1(db);
  for(const [id,name] of [['primary-admin','オーナー'],['subject','本人'],['third','第三者']])db.prepare("INSERT INTO security_identities(id,display_name,status) VALUES (?,?,'active')").run(id,name);
  for(const id of ['primary-admin','subject']){db.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES (?,?, 'test', 'test', 'active')").run(`credential-${id}`,id);db.prepare('INSERT INTO security_health_members VALUES (?,?)').run(id==='primary-admin'?'owner':'subject',id);db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES (?,?,'health','nobumi','体調管理（田中暢美）','active')").run(`link-${id}`,id);}
  return{db,env:{DB},actor:id=>({identityId:id,credentialId:`credential-${id}`,authenticatedAt:Math.floor(Date.now()/1000)})};
}
const helpers={HttpError:ErrorType,readJson:async r=>r.json(),json:Response.json,audit:async()=>{}};
function request(value){return new Request('https://tanaka-note.com/security/api/health',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});}
test('migration preserves foreign keys and blocks a third member at database and API boundaries',async()=>{
  const f=setup();try{
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
    await assert.rejects(assertHealthMemberAvailable(f.env.DB,'third',ErrorType),e=>e.status===403);
    await healthMembershipStatement(f.env.DB,'third').run();
    assert.throws(()=>f.db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label) VALUES ('third-link','third','health','nobumi','x')").run());
    assert.equal(await healthKeyBundle(f.env,{identityId:'third',credentialId:'x',serviceLinkId:'x'}),null);
    assert.ok(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='security_service_links'").get().sql.includes("'health'"));
  }finally{f.db.close();}
});
test('encrypted key registration, initialization and grant allow recovery; revoked credentials and links fail closed',async()=>{
  const f=setup();let master=crypto.getRandomValues(new Uint8Array(32));try{
    const admin=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
    const pub=await crypto.subtle.exportKey('jwk',admin.publicKey);f.env.CLOUD_AUTH={getPrimaryAdminCryptoConfig:async()=>({initialized:true,publicKeyJwk:pub})};
    const prf=crypto.getRandomValues(new Uint8Array(32));const vault=await createClientVault(prf);
    await handleHealthKeys('/api/health/vault',request(vault),f.env,f.actor('subject'),helpers);
    await handleHealthKeys('/api/health/vault',request(vault),f.env,f.actor('subject'),helpers);
    await assert.rejects(handleHealthKeys('/api/health/vault',request(await createClientVault(prf)),f.env,f.actor('subject'),helpers),e=>e.status===409);
    await assert.rejects(handleHealthKeys('/api/health/initialize',request({recoveryWrappedKey:await wrapMaster(master,pub, 'nobumi')}),f.env,f.actor('subject'),helpers),e=>e.status===403);
    const recoveryWrappedKey=await wrapMaster(master,pub, 'nobumi');
    await handleHealthKeys('/api/health/initialize',request({recoveryWrappedKey}),f.env,f.actor('primary-admin'),helpers);
    await assert.rejects(handleHealthKeys('/api/health/initialize',request({recoveryWrappedKey:await wrapMaster(master,pub, 'nobumi')}),f.env,f.actor('primary-admin'),helpers),e=>e.status===409);
    const grant={credentialId:'credential-subject',serviceLinkId:'link-subject',wrappedKey:await wrapMaster(master,vault.publicKey, 'nobumi')};
    await handleHealthKeys('/api/health/grant',request(grant),f.env,f.actor('primary-admin'),helpers);
    const input={identityId:'subject',credentialId:grant.credentialId,serviceLinkId:grant.serviceLinkId};const bundle=await healthKeyBundle(f.env,input);
    assert.deepEqual(await unwrapMaster(await unlockClient(prf,bundle.vault),bundle.wrappedKey, 'nobumi'),master);
    assert.deepEqual(await unwrapMaster(admin.privateKey,recoveryWrappedKey, 'nobumi'),master);
    f.db.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id='credential-subject'").run();assert.equal(await healthKeyBundle(f.env,input),null);
    f.db.prepare("UPDATE security_credentials SET status='active' WHERE credential_id='credential-subject'").run();f.db.prepare("UPDATE security_service_links SET status='disabled' WHERE id='link-subject'").run();assert.equal(await healthKeyBundle(f.env,input),null);
    await assert.rejects(handleHealthKeys('/api/health/grant',request(grant),f.env,f.actor('primary-admin'),helpers),e=>e.status===403);
  }finally{master.fill(0);f.db.close();}
});
