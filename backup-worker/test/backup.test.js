import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SERVICES } from '../src/registry.js';
import { capture, backupService, compress, decode, digest } from '../src/backup.js';
import { runState, reportRun } from '../src/monitor.js';
import { getBackupSnapshot } from '../src/browser.js';
import { database, d1, Bucket, recorder } from './fixtures.mjs';

test('every allowlist executes against current migrations and round-trips into an isolated schema', async () => {
  for (const service of Object.keys(SERVICES)) {
    const source = database(service), destination = database(service);
    try {
      if (service === 'health') source.exec("INSERT INTO health_records VALUES ('opaque-id','nobumi','synthetic-iv','synthetic-ciphertext',2,'2026-10-25 00:00:00')");
      if (service === 'cloud') source.exec("INSERT INTO cloud_folders(id,name,created_by) VALUES (101,'synthetic','admin'); INSERT INTO cloud_files(folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by) VALUES (101,'encrypted-object','fixture','application/octet-stream','document',100,'ready','admin')");
      if (service === 'billing') source.exec("INSERT INTO billing_entries(account_id,document_type,entry_date,category,amount_yen,description,created_by) VALUES ('owner','invoice','2026-10-25','purchase',123,'synthetic','owner')");
      const snapshot = await decode(await compress(await capture(d1(source), service)));
      assert.equal(snapshot.service, service);
      assert.ok(snapshot.schema.length);
      destination.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
      for (const t of [...SERVICES[service].tables].reverse()) destination.exec(`DELETE FROM ${t.name}`);
      for (const t of SERVICES[service].tables) {
        const statement = destination.prepare(`INSERT INTO ${t.name} (${t.columns.join(',')}) VALUES (${t.columns.map(() => '?').join(',')})`);
        for (const row of snapshot.tables[t.name].rows) statement.run(...t.columns.map(c => row[c]));
      }
      destination.exec('COMMIT');
      assert.equal(destination.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(destination.prepare('PRAGMA foreign_key_check').all(), []);
      for (const t of SERVICES[service].tables) assert.deepEqual(
        destination.prepare(`SELECT ${t.columns.join(',')} FROM ${t.name}`).all().map(r => ({ ...r })), snapshot.tables[t.name].rows, `${service}/${t.name}`);
      const text = JSON.stringify(snapshot.tables);
      for (const excluded of ['password_hash', 'security_challenges', 'security_handoffs', 'security_active_sessions', 'cloud_folder_unlocks', 'downloader_jobs']) assert.equal(text.includes('"' + excluded + '"'), false);
    } finally { source.close(); destination.close(); }
  }
});

test('successful backups verify bytes, preserve a daily generation, and retain 30 daily / 12 monthly', async () => {
  const db = database('health'), bucket = new Bucket(), monitor = recorder();
  const env = { HEALTH_DB: d1(db), BACKUP: bucket, ...monitor };
  try {
    const now = Date.now();
    const seed = await compress(await capture(d1(db), 'health'));
    const options = { customMetadata: { sha256: await digest(seed) } };
    for (let i = 50; i > 0; i--) {
      const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
      await bucket.put(`d1/health/v2/daily/${day}.json.gz`, seed, options);
    }
    for (let i = 0; i < 14; i++) {
      const month = new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 7);
      await bucket.put(`d1/health/v2/monthly/${month}.json.gz`, seed, options);
    }
    const result = await backupService(env, 'health', now, async () => {});
    assert.equal(result.state, 'ok');
    const generations = [...bucket.objects.keys()].filter(k => k.includes('/daily/'));
    assert.equal(generations.length, 30);
    assert.equal([...bucket.objects.keys()].filter(k => k.includes('/monthly/')).length, 12);
    const current = generations.sort().at(-1), hash = await digest(bucket.objects.get(current).bytes);
    db.exec("INSERT INTO health_records VALUES ('later','nobumi','iv','cipher',1,'2026-10-25')");
    await backupService(env, 'health', now, async () => {});
    assert.equal(await digest(bucket.objects.get(current).bytes), hash);
    assert.equal([...bucket.objects.keys()].some(k => k.includes('/attempts/')), false);
    assert.ok(monitor.events.some(e => e.eventType === 'backup_succeeded'));
  } finally { db.close(); }
});

test('save/verification failures retry, preserve previous generations, and emit no payload', async () => {
  for (const mode of ['failPut', 'corrupt']) {
    const db = database('health'), bucket = new Bucket(), monitor = recorder();
    try {
      await bucket.put('d1/health/daily/2026-01-01.json.gz', new Uint8Array([1])); bucket[mode] = true;
      const result = await backupService({ HEALTH_DB: d1(db), BACKUP: bucket, ...monitor }, 'health', Date.now(), async () => {});
      assert.equal(result.state, 'failed');
      assert.ok(bucket.objects.has('d1/health/daily/2026-01-01.json.gz'));
      const failed = monitor.events.find(e => e.eventType === 'backup_failed');
      assert.equal(failed.details.attempt, 3);
      assert.doesNotMatch(JSON.stringify(monitor.events), /sensitive payload/);
    } finally { db.close(); }
  }
});

test('missing bindings and failed audit delivery cannot be reported as successful', async () => {
  const monitor = recorder();
  assert.equal((await backupService({ BACKUP: new Bucket(), ...monitor }, 'health', Date.now(), async () => {})).state, 'failed');
  assert.equal((await backupService({}, 'health', Date.now(), async () => {})).state, 'audit_unavailable');
  const queued = [];
  assert.equal(await reportRun({ SECURITY: { recordAuditEvent: async () => { throw new Error(); } }, SECURITY_AUDIT: { send: async e => queued.push(e) } }, 'health', crypto.randomUUID(), 'failed', { reason: 'safe_code', secret: 'discard' }), true);
  assert.equal(queued.length, 1); assert.equal(queued[0].details.secret, undefined);
});

test('status detects missed schedules, stale running jobs and recovery without erasing failures', () => {
  const now = Date.parse('2026-10-25T04:00:00+09:00');
  assert.equal(runState([], { now }).state, 'overdue');
  const events = [{ event_id: 'one', occurred_at: '2026-10-23T18:40:00Z', event_type: 'backup_started' }];
  assert.equal(runState(events, { now }).state, 'overdue');
  events.push({ event_id: 'two', occurred_at: '2026-10-24T18:40:00Z', event_type: 'backup_failed', details_json: '{"reason":"save_failed"}' });
  assert.equal(runState(events, { now }).state, 'failed');
  events.push({ event_id: 'three', occurred_at: '2026-10-24T18:41:00Z', event_type: 'backup_succeeded' });
  const state = runState(events, { now });
  assert.equal(state.state, 'ok'); assert.equal(state.history.length, 3);
});

test('backup Worker has no public route, file bodies, restored sessions or production deploy script', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url)));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.equal(config.routes, undefined);
  assert.deepEqual(config.r2_buckets.map(b => b.bucket_name), ['t-room-service-backups']);
  assert.equal(SERVICES.downloader.tables.length, 1);
  assert.equal(SERVICES.downloader.tables[0].name, 'downloader_usage_daily');
});

test('schema drift fails closed instead of silently omitting new durable data', async () => {
  const db = database('health');
  try {
    db.exec('ALTER TABLE health_records ADD COLUMN new_durable_value TEXT');
    await assert.rejects(capture(d1(db), 'health'), /SchemaReviewRequired/);
  } finally { db.close(); }
});

test('storage listings are cached while failures and recoveries remain fresh', async () => {
  const db = database('security'), bucket = new Bucket(), env = { SECURITY_DB: d1(db), BACKUP: bucket };
  let stored, lists = 0;
  const list = bucket.list.bind(bucket); bucket.list = args => { lists++; return list(args); };
  const cache = { async match() { return stored?.clone(); }, async put(_key, value) { stored = value; } };
  try {
    const first = await getBackupSnapshot(env, {}, cache);
    assert.equal(first.services.length, 9); const count = lists;
    db.prepare("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,target_type,target_id,details_json) VALUES (?,?,?,?,?,?,?,?)")
      .run('failed-run', new Date().toISOString(), 'health', 'backup_failed', 'failure', 'backup', 'health', '{"reason":"operation_failed"}');
    const second = await getBackupSnapshot(env, {}, cache);
    assert.equal(lists, count);
    assert.equal(second.services.find(s => s.id === 'health').state, 'failed');
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM security_audit_events WHERE target_type='backup' AND target_id='health' ORDER BY occurred_at DESC,event_id DESC LIMIT 40").all();
    assert.match(JSON.stringify(plan), /idx_security_backup_status/);
    const broken = { ...env, SECURITY_DB: { prepare() { throw new Error('Unavailable'); } } };
    assert.ok((await getBackupSnapshot(broken, {}, cache)).services.every(s => s.state === 'unavailable'));
  } finally { db.close(); }
});
