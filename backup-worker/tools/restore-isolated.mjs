// Node-only recovery rehearsal. No caller-supplied database/path/SQL, no network
// and no production write API. The returned database is always :memory:.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SERVICES } from '../src/registry.js';
import { validateSnapshot } from '../src/backup.js';
import { verifiedGeneration } from '../src/integrity.js';
import { BACKUP_TABLES } from '../../diary-worker/src/backup.js';

export async function restoreIsolated(bucket, key, service) {
  const tables=service==='diary'?BACKUP_TABLES:SERVICES[service]?.tables;
  if(!tables) throw new Error('UnsupportedService');
  const verified=await verifiedGeneration(bucket,key,p=>{
    if(service!=='diary') return validateSnapshot(p,service);
    if(p.formatVersion!==7 || p.source?.database!=='diary-db') throw new Error('SnapshotInvalid');
    assert.deepEqual(Object.keys(p.tables).sort(),tables.map(t=>t.name).sort());
    for(const t of tables) {
      assert.deepEqual(p.tables[t.name].columns,t.columns);
      assert.equal(p.tables[t.name].rowCount,p.tables[t.name].rows.length);
    }
  });
  if(!verified) throw new Error('GenerationMissing');
  const db=new DatabaseSync(':memory:');
  try {
    const dir=new URL(`../../${service}-worker/migrations/`,import.meta.url);
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file,dir),'utf8'));
    // Triggers are from trusted migrations, never from the archive. Disable
    // replay side effects (inventory stock, immutable audit, etc.) only here.
    const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
    for(const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    for(const t of [...tables].reverse()) db.exec(`DELETE FROM ${t.name}`);
    for(const t of tables) {
      const columns=[...t.columns,...(t.name==='diary_accounts'?['login_id']:[])];
      const insert=db.prepare(`INSERT INTO ${t.name} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      for(const r of verified.payload.tables[t.name].rows) insert.run(...t.columns.map(c=>r[c]),...(t.name==='diary_accounts'?[`restored-${r.id}@invalid.local`]:[]));
    }
    // Check every archived cell before deliberate authorization quarantine.
    const canonical=rows=>rows.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort();
    for(const t of tables) assert.deepEqual(canonical(db.prepare(`SELECT ${t.columns.join(',')} FROM ${t.name}`).all()),canonical(verified.payload.tables[t.name].rows),t.name);
    if(service==='security') db.exec("UPDATE security_identities SET status='disabled',is_security_admin=0; UPDATE security_credentials SET status='revoked'; UPDATE security_service_links SET status='disabled'; UPDATE security_invitations SET status='expired'");
    if(['billing','payments','inventory','calendar','household','portfolio'].includes(service)) db.exec(`UPDATE ${service}_accounts SET is_active=0,session_version=session_version+1`);
    if(service==='diary') db.exec('UPDATE diary_accounts SET active=0,session_version=session_version+1,must_change_password=1');
    if(service==='ai') db.exec("UPDATE ai_accounts SET status='disabled'; UPDATE ai_request_claims SET status='failed',error_code='isolated_restore' WHERE status='processing'");
    for(const t of triggers) db.exec(t.sql);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec('COMMIT');
    return { db, payload: verified.payload, sha256: verified.sha256 };
  } catch(error) { db.close(); throw error; }
}
