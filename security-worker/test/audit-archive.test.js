import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveAuditEvents } from '../src/audit-archive.js';
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
