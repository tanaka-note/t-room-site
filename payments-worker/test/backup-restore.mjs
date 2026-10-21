// Synthetic local D1 only. No production config, credentials, remote DB or data.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'payments-restore-'));
const config=join(root,'wrangler.json'), source=join(root,'.wrangler','state'), restored=join(root,'restored');
const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
function command(args) {
  try { return execFileSync(process.execPath,[wrangler,...args,'--config',config],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'},timeout:60000}); }
  catch (error) { throw new Error('Synthetic local D1 command failed: '+args[1]+' '+String(error.stderr || error.stdout).slice(-1800)); }
}
function database(dir, readOnly=true) {
  const files=readdirSync(dir,{recursive:true}).filter(f=>String(f).endsWith('.sqlite'));
  for (const file of files) {
    const db = new DatabaseSync(join(dir,file), {readOnly});
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='payments_entries'").get()) return db;
    db.close();
  }
  throw new Error('Synthetic payments database missing');
}
const tables=['payments_accounts','payments_entries','payments_requests','payments_monthly_marks','payments_operation_audit'];
const snapshot=db=>tables.map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
try {
  writeFileSync(config,JSON.stringify({name:'payments-restore-synthetic',compatibility_date:'2026-10-14',d1_databases:[{binding:'DB',database_name:'payments-restore-synthetic',database_id:'00000000-0000-4000-8000-000000000001'}]}));
  for(const file of ['0001_payments.sql','0002_monthly_ledger.sql']) command(['d1','execute','DB','--local','--persist-to',source,'--file',fileURLToPath(new URL(`../migrations/${file}`,import.meta.url))]);
  const seed=join(root,'synthetic.sql');
  writeFileSync(seed,`INSERT INTO payments_accounts VALUES ('owner','Synthetic Owner',1,1);
    INSERT INTO payments_entries VALUES ('synthetic-entry','owner','2020-01-01','Synthetic','',10000,'2020-01',12,'',1,'2020-01-01','2020-01-01',NULL);
    INSERT INTO payments_requests VALUES ('synthetic-request','synthetic-fingerprint','{"id":"synthetic-entry"}','2020-01-01');
    INSERT INTO payments_monthly_marks VALUES ('synthetic-entry','2020-01',834,'2020-02-01T00:00:00Z');
    INSERT INTO payments_monthly_marks VALUES ('synthetic-entry','2020-02',834,NULL);
    INSERT INTO payments_operation_audit(request_id,entry_id,target_month,action,occurred_at,identity_id,account_id,entry_version,amount) VALUES ('synthetic-request','synthetic-entry','2020-01','month_complete','2020-02-01T00:00:00Z','primary-admin','owner',1,834);`);
  command(['d1','execute','DB','--local','--persist-to',source,'--file',seed]);
  const db=database(source), before=snapshot(db); db.close();
  const dump=join(root,'backup.sql'); command(['d1','export','DB','--local','--output',dump]);
  command(['d1','execute','DB','--local','--persist-to',restored,'--file',dump]);
  const copy=database(restored,false);
  try {
    assert.deepEqual(snapshot(copy),before); assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.throws(()=>copy.exec('DELETE FROM payments_operation_audit'),/immutable/);
    assert.throws(()=>copy.exec("UPDATE payments_entries SET amount=1,version=2"),/completed_locked/);
    assert.equal(copy.prepare("SELECT amount FROM payments_monthly_marks WHERE target_month='2020-01'").get().amount,834);
    assert.equal(copy.prepare("SELECT completed_at FROM payments_monthly_marks WHERE target_month='2020-02'").get().completed_at,null);
  } finally {copy.close();}
  console.log('Local D1 export/import restore: 5 tables identical; entries, complete/cancelled marks, requests, audit, triggers, integrity and foreign keys passed.');
} finally { rmSync(root,{recursive:true,force:true}); }
