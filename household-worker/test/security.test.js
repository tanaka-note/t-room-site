import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {bundle,d1,fixture,household} from './fixture.js';
const directory=new URL('../../security-worker/migrations/',import.meta.url),migration='0026_household_service.sql';
const security=await bundle(new URL('../../security-worker/src/index.js',import.meta.url),'\nexport {validateServiceLinks,validatePasskeySession,passkeyRollingSession};');
function db(){const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync(directory).filter(n=>n.endsWith('.sql')&&n<migration).sort())sqlite.exec(readFileSync(new URL(file,directory),'utf8'));return sqlite;}
function apply(sqlite){sqlite.exec(readFileSync(new URL(migration,directory),'utf8'));}
function seed(sqlite){sqlite.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES ('primary-admin','Sample Owner','active',1),('sample-viewer','Sample Viewer','active',0);
INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES ('sample-credential','primary-admin','AQI','YWJj','active'),('dmlld2VyLWNyZWRlbnRpYWw','sample-viewer','AQI','YWJj','active');
INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES ('cloud-link','primary-admin','cloud','folder-member',7,'Sample folder','active');
INSERT INTO security_handoffs(id,token_hash,identity_id,service_link_id,credential_id,expires_at,cloud_folder_scopes) VALUES ('sample-handoff','sample-hash','primary-admin','cloud-link','sample-credential',9999999999,'[7]');
INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key) VALUES ('sample-envelope','primary-admin','sample-credential','cloud-link','folder_key_rsa','synthetic-encrypted-key');
INSERT INTO security_health_members VALUES ('owner','primary-admin');
INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES ('health-link','primary-admin','health','nobumi','Sample','active');
INSERT INTO security_health_grants VALUES ('primary-admin','sample-credential','health-link','synthetic-wrapped-key');
INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,identity_id) VALUES ('sample-event','2026-01-01','cloud','passkey_login_success','success','primary-admin');`);}
test('service extension preserves all existing records, envelopes, scopes, totals and foreign keys; does not auto-grant access',()=>{
 const sqlite=db();try{seed(sqlite);const names=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name),snapshot=()=>Object.fromEntries(names.map(name=>[name,sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));const before=snapshot();
 sqlite.exec('PRAGMA foreign_keys=ON;BEGIN');try{apply(sqlite);assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(snapshot(),before);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_service_links WHERE service='household'").get().n,0);
 apply(sqlite);assert.deepEqual(snapshot(),before);
 const insert=sqlite.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES (?,?,'household',?,'Sample','active')");insert.run('owner-link','primary-admin','owner');insert.run('viewer-link','sample-viewer','viewer');assert.throws(()=>insert.run('bad-owner','sample-viewer','owner'));assert.throws(()=>insert.run('unknown-role','sample-viewer','admin'));
 }finally{sqlite.close();}
});
test('existing Security validation accepts explicit household viewer grants, restricts owners, tracks and revokes sessions',async()=>{
 const sqlite=db(),f=fixture();try{seed(sqlite);apply(sqlite);const provider=new household.SecurityIntegration({},f.env),env={DB:d1(sqlite),SESSION_SECRET:randomBytes(32).toString('hex'),PASSKEY_ENABLED:'true',HOUSEHOLD_AUTH:provider};
 const admin={identityId:'primary-admin',authenticatedAt:Math.floor(Date.now()/1000)};
 const links=await security.validateServiceLinks(env,[{service:'household',accountId:'viewer'}],{identityId:'sample-viewer',admin});assert.equal(links[0].role,'viewer');assert.equal(links[0].shared,true);
 await assert.rejects(()=>security.validateServiceLinks(env,[{service:'household',accountId:'owner'}],{identityId:'sample-viewer',admin}),{status:403});
 await assert.rejects(()=>security.validateServiceLinks(env,[{service:'household',accountId:'viewer'}],{identityId:'sample-viewer',admin:{...admin,authenticatedAt:0}}),{status:428});
 sqlite.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES ('viewer-link','sample-viewer','household','viewer','Sample','active')");
 const input={service:'household',identityId:'sample-viewer',credentialId:'dmlld2VyLWNyZWRlbnRpYWw',serviceLinkId:'viewer-link',serviceAccountId:'viewer',role:'viewer',sessionEpoch:1};assert.equal((await security.validatePasskeySession(env,input)).valid,true);
 const tracked={...input,action:'register',sessionIdHash:randomBytes(32).toString('base64url'),sessionVersion:'1:1',startedAt:new Date().toISOString(),expiresAt:Math.floor(Date.now()/1000)+43200,ttlSeconds:43200};
 assert.equal((await security.passkeyRollingSession(env,tracked)).valid,true);assert.equal((await security.passkeyRollingSession(env,{...tracked,action:'read'})).valid,true);assert.equal((await security.passkeyRollingSession(env,{...tracked,action:'touch'})).valid,true);
 sqlite.exec("UPDATE security_service_links SET status='disabled' WHERE id='viewer-link'");assert.equal((await security.validatePasskeySession(env,input)).valid,false);assert.equal((await security.passkeyRollingSession(env,{...tracked,action:'read'})).valid,false);
 }finally{f.close();sqlite.close();}
});
