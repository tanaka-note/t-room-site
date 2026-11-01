import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
test('Portfolio migration retains existing rows, all indexes/triggers and FK relations, without creating grants',()=>{
 const db=new DatabaseSync(':memory:'),directory=new URL('../migrations/',import.meta.url);
 try {
  db.exec('PRAGMA foreign_keys=ON');for(const f of readdirSync(directory).filter(f=>f.endsWith('.sql')&&f<'0030_').sort())db.exec(readFileSync(new URL(f,directory),'utf8'));
  db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture','active',1),('sample','Fixture','active',0);
   INSERT INTO security_credentials(credential_id,identity_id,public_key,counter,status,label,prf_salt) VALUES('credential','primary-admin','fixture',0,'active','Fixture','fixture');
   INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('one','primary-admin','household','chiharu-admin','Fixture','active'),('two','sample','household','chiharu-admin','Fixture','active');
   INSERT INTO security_handoffs(id,token_hash,identity_id,service_link_id,credential_id,expires_at,session_epoch) VALUES('handoff','fixture','primary-admin','one','credential',4102444800,1);
   INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome) VALUES('audit','2026-10-31T00:00:00.000Z','calendar','passkey_login_success','success');
   INSERT INTO security_active_sessions(session_id_hash,identity_id,service,service_link_id,service_account_id,credential_id,role,auth_method,session_version,started_at,last_seen_at,expires_at) VALUES('old','primary-admin','calendar','one','main','credential','member','passkey','1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,4102444800);`);
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  const rows=Object.fromEntries(names.map(n=>[n,db.prepare(`SELECT * FROM ${n}`).all()]));
  const objects=db.prepare("SELECT type,name FROM sqlite_schema WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.exec('BEGIN');db.exec(readFileSync(new URL('0030_portfolio_service.sql',directory),'utf8'));db.exec('COMMIT');
  for(const name of names)assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(),rows[name],name);
  const after=db.prepare("SELECT type,name FROM sqlite_schema WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'portfolio_%' ORDER BY type,name").all();assert.deepEqual(after,objects);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM security_service_links WHERE service='portfolio'").get().n,0);
  db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('portfolio','primary-admin','portfolio','owner','Fixture','active')");
  assert.throws(()=>db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('wrong','sample','portfolio','owner','Fixture','active')"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM security_credentials").get().n,1);
 }finally{db.close();}
});
