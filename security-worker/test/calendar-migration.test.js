import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {trackedPasskeySession} from '../src/rolling-sessions.js';
import {passkeyTtlSecondsForService} from '../../assets/passkey-calendar-policy.mjs';
const dir=new URL('../migrations/',import.meta.url);
function fixture(before=false){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync(dir).filter(f=>f.endsWith('.sql')&&(!before||f<'0027_')).sort())db.exec(readFileSync(new URL(name,dir),'utf8'));return db;}
function seed(db){db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture','active',1);
  INSERT INTO security_credentials(credential_id,identity_id,public_key,counter,status,label,prf_salt) VALUES('credential','primary-admin','fixture',0,'active','Fixture','fixture');
  INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('link','primary-admin','ai','owner','Fixture','active');
  INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('household-owner','primary-admin','household','owner','Fixture','active'),('household-viewer','primary-admin','household','viewer','Fixture','active');
  INSERT INTO security_handoffs(id,token_hash,identity_id,service_link_id,credential_id,expires_at,session_epoch) VALUES('handoff','fixture','primary-admin','link','credential',4102444800,1);
  INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key) VALUES('envelope','primary-admin','credential','link','folder_key_rsa','fixture');
  INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome) VALUES('audit','2026-10-29T00:00:00.000Z','ai','passkey_login_success','success');
  INSERT INTO security_active_sessions(session_id_hash,identity_id,service,service_link_id,service_account_id,credential_id,role,auth_method,session_version,started_at,last_seen_at,expires_at) VALUES('old-session','primary-admin','ai','link','owner','credential','admin','passkey','1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,4102444800)`);}
test('Calendar migration preserves every existing table row, index, trigger and foreign key with FK enforcement enabled',()=>{
  const db=fixture(true);try{seed(db);const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);const before=Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT * FROM ${name}`).all()]));const objects=db.prepare("SELECT type,name FROM sqlite_schema WHERE type IN('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    db.exec('BEGIN');db.exec(readFileSync(new URL('0027_calendar_service.sql',dir),'utf8'));db.exec('COMMIT');
    for(const name of tables)assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(),before[name],name);
    assert.deepEqual(db.prepare("SELECT type,name FROM sqlite_schema WHERE type IN('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),objects);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM security_service_links WHERE service='calendar'").get().n,0,'no automatic grants');
    db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('calendar','primary-admin','calendar','main','Fixture','active')");
  }finally{db.close();}
});
test('only Calendar may register and roll for 30 days; existing services retain their 12-hour ceiling',async()=>{
  const db=fixture();try{seed(db);const prepare=(sql,args=[])=>({bind:(...a)=>prepare(sql,a),first:async()=>db.prepare(sql).get(...args)||null,run:async()=>({meta:{changes:db.prepare(sql).run(...args).changes}})});const env={DB:{prepare}},now=Math.floor(Date.now()/1000);
    db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('calendar','primary-admin','calendar','main','Fixture','active')");
    const claims={service:'calendar',action:'register',sessionIdHash:randomBytes(32).toString('base64url'),identityId:'primary-admin',credentialId:'credential',role:'member',serviceAccountId:'main',serviceLinkId:'calendar',sessionVersion:'1:1',sessionEpoch:1,startedAt:new Date().toISOString(),expiresAt:now+30*86400-1,ttlSeconds:30*86400};
    assert.equal((await trackedPasskeySession(env,claims,async()=>true)).valid,true);assert.equal((await trackedPasskeySession(env,{...claims,action:'touch'},async()=>true)).valid,true);
    assert.equal((await trackedPasskeySession(env,{...claims,action:'touch',ttlSeconds:43200},async()=>true)).valid,false);
    assert.equal((await trackedPasskeySession(env,{...claims,service:'ai',serviceAccountId:'owner',serviceLinkId:'link',sessionIdHash:randomBytes(32).toString('base64url')},async()=>true)).valid,false);
    assert.equal((await trackedPasskeySession(env,claims,async()=>false)).valid,false);
    for(const service of ['security','cloud','diary','billing','ai','downloader','downloader2','inventory','health','payments','household'])assert.equal(passkeyTtlSecondsForService(service),43200,service);
  }finally{db.close();}
});
