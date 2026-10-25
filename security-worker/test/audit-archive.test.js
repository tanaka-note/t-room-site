import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveAuditEvents, archiveIfPending, pendingArchive } from '../src/audit-archive.js';
import { database, d1, Bucket } from '../../backup-worker/test/fixtures.mjs';
import { decode } from '../../backup-worker/src/backup.js';

const cutoff = '2026-04-28T00:00:00.000Z';
function fixture() {
  const db = database('security'), bucket = new Bucket(), events = [];
  db.prepare("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,auth_method) VALUES (?,?,?,?,?,?)").run('old','2026-01-01T00:00:00.000Z','cloud','passkey_login_success','success','passkey');
  db.prepare("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome) VALUES (?,?,?,?,?)").run('recent','2026-10-25T00:00:00.000Z','security','admin_access','success');
  return { db, bucket, events, env: { DB: d1(db), AUDIT_ARCHIVE: bucket, recordArchiveAudit: async event => { events.push(event); return { stored: true }; } } };
}
test('only verified unchanged archived rows leave D1; the archive and current records remain', async () => {
  const f = fixture();
  try {
    assert.equal(await archiveAuditEvents(f.env, cutoff), true);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM security_audit_events WHERE event_id='old'").get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM security_audit_events WHERE event_id='recent'").get().n, 1);
    const saved = [...f.bucket.objects.values()][0];
    const archive = await decode(saved.bytes);
    assert.equal(archive.rows[0].event_id, 'old'); assert.equal(archive.rows[0].event_type, 'passkey_login_success');
    assert.equal(f.events.at(-1).eventType, 'backup_succeeded');
    const count = f.bucket.objects.size;
    await archiveAuditEvents(f.env, cutoff);
    assert.equal(f.bucket.objects.size, count);
  } finally { f.db.close(); }
});

test('summary write/readback/CAS failure keeps originals and a retry safely resumes', async()=>{
  for(const mode of ['write','read','cas']) {
    const f=fixture();
    try {
      const put=f.bucket.put.bind(f.bucket), get=f.bucket.get.bind(f.bucket);
      f.bucket.put=async(key,...args)=>{if(key.startsWith('_metadata/')&&mode==='write') throw new Error('metadata');if(key.startsWith('_metadata/')&&mode==='cas') return null;return put(key,...args);};
      f.bucket.get=async key=>{if(key.startsWith('_metadata/')&&mode==='read') throw new Error('readback');return get(key);};
      assert.equal(await archiveAuditEvents(f.env,cutoff),false);
      assert.ok(f.db.prepare("SELECT 1 FROM security_audit_events WHERE event_id='old'").get());
      f.bucket.put=put; f.bucket.get=get;
      assert.equal(await archiveAuditEvents(f.env,cutoff),true);
      assert.equal([...f.bucket.objects.keys()].filter(k=>k.startsWith('security-audit/')).length,1,'stable pack key on retry');
    } finally {f.db.close();}
  }
});
test('bounded indexed backlog probe and hourly catchup drain more than 1000 old rows without hiding recent history',async()=>{
  const f=fixture();
  try {
    const put=f.db.prepare("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome) VALUES (?,'2026-01-01T00:00:00Z','cloud','login','success')");
    f.db.exec('BEGIN');for(let i=0;i<1600;i++) put.run('synthetic-'+String(i).padStart(4,'0'));f.db.exec('COMMIT');
    const pending=await pendingArchive(f.env,cutoff);
    assert.equal(pending.pendingCount,1001);assert.equal(pending.pendingCapped,true);
    const plan=f.db.prepare('EXPLAIN QUERY PLAN SELECT occurred_at FROM security_audit_events WHERE occurred_at < ? ORDER BY occurred_at,event_id LIMIT 1001').all(cutoff);
    assert.match(JSON.stringify(plan),/USING.*INDEX/);
    assert.equal(await archiveAuditEvents(f.env,cutoff),false);
    assert.equal(f.events.at(-1).details.pendingCount,601);
    assert.equal(await archiveIfPending(f.env,cutoff),false);
    assert.equal(f.events.at(-1).details.pendingCount,101);
    assert.equal(await archiveIfPending(f.env,cutoff),true);
    assert.deepEqual(f.db.prepare('SELECT event_id FROM security_audit_events').all().map(r=>r.event_id),['recent']);
    const packs=await Promise.all([...f.bucket.objects].filter(([k])=>k.startsWith('security-audit/')).map(([,o])=>decode(o.bytes)));
    assert.equal(new Set(packs.flatMap(p=>p.rows.map(r=>r.event_id))).size,1601);
  } finally {f.db.close();}
});
test('schema drift and transactional delete failure leave every uncommitted original',async()=>{
  for(const mode of ['schema','delete']) {
    const f=fixture();
    try {
      if(mode==='schema') f.db.exec('ALTER TABLE security_audit_events ADD COLUMN new_value TEXT');
      else {
        const batch=f.env.DB.batch.bind(f.env.DB);
        f.env.DB.batch=items=>items.some(i=>i.sql.startsWith('DELETE'))?Promise.reject(new Error('db failure')):batch(items);
      }
      assert.equal(await archiveAuditEvents(f.env,cutoff),false);
      assert.ok(f.db.prepare("SELECT 1 FROM security_audit_events WHERE event_id='old'").get());
    } finally {f.db.close();}
  }
});
test('missing R2, write failures and corrupt readback never delete source audit records', async () => {
  for (const mode of ['missing', 'failPut', 'corrupt']) {
    const f = fixture();
    try {
      if (mode === 'missing') delete f.env.AUDIT_ARCHIVE; else f.bucket[mode] = true;
      assert.equal(await archiveAuditEvents(f.env, cutoff), false);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM security_audit_events').get().n, 2);
      assert.equal(f.events.at(-1).eventType, 'backup_failed');
      assert.doesNotMatch(JSON.stringify(f.events), /sensitive payload/);
    } finally { f.db.close(); }
  }
});
test('a record modified during archival remains in D1 for the next run', async () => {
  const f = fixture();
  try {
    const get = f.bucket.get.bind(f.bucket);
    f.bucket.get = async key => { const result = await get(key); f.db.exec("UPDATE security_audit_events SET details_json='{\"later\":true}' WHERE event_id='old'"); return result; };
    await archiveAuditEvents(f.env, cutoff);
    // The first immutable copy preserves the original; the next pass can archive
    // the updated version. Every removed version must have a matching copy.
    const copies = await Promise.all([...f.bucket.objects.values()].map(v => decode(v.bytes)));
    const records = copies.filter(c => Array.isArray(c.rows));
    assert.ok(records.some(c => c.rows.some(r => r.event_id === 'old' && r.details_json === '{}')));
    if (!f.db.prepare("SELECT 1 FROM security_audit_events WHERE event_id='old'").get()) assert.ok(records.some(c => c.rows.some(r => r.details_json.includes('later'))));
  } finally { f.db.close(); }
});
