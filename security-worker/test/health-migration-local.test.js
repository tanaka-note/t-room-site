import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { migrationNames, migrationSql, legacySeedSql, snapshot, existingTables, oldServices } from './health-migration-fixture.mjs';

test('0022 preserves every legacy row, primary/foreign key, index and uniqueness constraint across all six services', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of migrationNames.filter(name=>name<'0022_')) db.exec(migrationSql(name));
    db.exec(legacySeedSql());
    const tables=existingTables(db), before=snapshot(db,tables);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec(migrationSql('0022_health_service.sql'));
    assert.deepEqual(snapshot(db,tables),before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual(db.prepare('SELECT DISTINCT service FROM security_service_links ORDER BY service').all().map(row=>row.service),[...oldServices].sort());
    // Exercise partial uniqueness and FK enforcement, not just index names.
    assert.throws(()=>db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES ('duplicate','fixture-0','cloud','account-0-0',42,'x','active')"));
    assert.throws(()=>db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES ('exclusive','fixture-1','billing','account-0-0','x','active')"));
    assert.throws(()=>db.exec("UPDATE security_handoffs SET service_link_id='missing' WHERE id='handoff-cloud-0-0'"));
    assert.throws(()=>db.exec("UPDATE security_handoffs SET token_hash='hash-cloud-0-0' WHERE id='handoff-cloud-0-1'"));
    assert.throws(()=>db.exec("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type) VALUES ('duplicate','fixture-0','credential-0-0','cloud-0-0','folder_key_rsa')"));
    assert.throws(()=>db.exec("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,session_id_hash) VALUES ('duplicate','2026-01-01T00:00:30Z','cloud','session_resume','success','session-cloud-0-0')"));
    assert.doesNotThrow(()=>db.exec("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome) VALUES ('health',CURRENT_TIMESTAMP,'health','session_resume','success')"));
  } finally { db.close(); }
});

test('actual Wrangler local D1 migrations roll back a mid-0022 failure and preserve populated legacy data on retry', {timeout:120000}, () => {
  const directory=mkdtempSync(resolve(tmpdir(),'health-migration-'));
  const migrations=resolve(directory,'migrations'), persistence=resolve(directory,'state');
  const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
  mkdirSync(migrations);
  writeFileSync(resolve(directory,'wrangler.json'),JSON.stringify({name:'health-migration-local',compatibility_date:'2026-08-20',
    d1_databases:[{binding:'DB',database_name:'health-migration-local',database_id:'11111111-2222-3333-4444-555555555555',migrations_dir:'migrations'}]}));
  const run=(...args)=>spawnSync(process.execPath,[wrangler,'d1',...args,'--local','--config',resolve(directory,'wrangler.json'),'--persist-to',persistence],{
    cwd:directory,encoding:'utf8',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},timeout:90000,maxBuffer:8*1024*1024});
  const apply=()=>run('migrations','apply','DB');
  const database=()=>{
    const location=resolve(persistence,'v3/d1/miniflare-D1DatabaseObject');
    const candidates=[];
    for(const name of readdirSync(location).filter(name=>name.endsWith('.sqlite'))) {
      const db=new DatabaseSync(resolve(location,name),{readOnly:true});
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='security_identities'").get())candidates.push(resolve(location,name));
      db.close();
    }
    assert.equal(candidates.length,1);return new DatabaseSync(candidates[0],{readOnly:true});
  };
  const read=()=>{const db=database();try{return {tables:existingTables(db),data:snapshot(db,existingTables(db)),schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE '__cf%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
    applied:db.prepare('SELECT name FROM d1_migrations ORDER BY id').all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all()};}finally{db.close();}};
  try {
    for(const name of migrationNames.filter(name=>name<'0022_'))writeFileSync(resolve(migrations,name),migrationSql(name));
    let result=apply();assert.equal(result.status,0,result.stderr);
    writeFileSync(resolve(directory,'seed.sql'),legacySeedSql());
    result=run('execute','DB','--file',resolve(directory,'seed.sql'));assert.equal(result.status,0,result.stderr);
    const before=read();assert.equal(before.applied.length,21);assert.deepEqual(before.foreignKeys,[]);
    const sql=migrationSql('0022_health_service.sql');
    const failing=sql.replace('DROP TABLE security_service_links;', 'DROP TABLE security_service_links;\nSELECT * FROM migration_injected_failure;');
    assert.notEqual(failing,sql);
    writeFileSync(resolve(migrations,'0022_health_service.sql'),failing);
    result=apply();assert.notEqual(result.status,0);assert.match(result.stderr+result.stdout,/migration_injected_failure/);
    assert.deepEqual(read(),before,'Wrangler batch restores old tables, child rows, indexes and migration history');
    writeFileSync(resolve(migrations,'0022_health_service.sql'),sql);
    result=apply();assert.equal(result.status,0,result.stderr);
    const after=read();assert.deepEqual(Object.fromEntries(before.tables.map(table=>[table,after.data[table]])),before.data);
    assert.equal(after.applied.length,22);assert.equal(after.applied.at(-1).name,'0022_health_service.sql');assert.deepEqual(after.foreignKeys,[]);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
