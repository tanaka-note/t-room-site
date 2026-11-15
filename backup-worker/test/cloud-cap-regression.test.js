import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, backupService } from '../src/backup.js';
import { snapshotStatement } from '../src/snapshot.js';
import { SERVICES } from '../src/registry.js';
import { database, d1, Bucket, recorder } from './fixtures.mjs';
import { saveExport, readExportManifest } from '../src/export-backup.js';
import { exportEnv, exportFetcher, sqlDump } from './export-fixtures.mjs';
import { restoreIsolated } from '../tools/restore-isolated.mjs';

// The bounded v2 capture remains a compatibility path. Scheduled backups now
// use the v3 export below; 10,000 rows must not become their global limit.
test('legacy T-Cloud row-cap overflow fails closed and preserves prior recovery generations', async () => {
  const db = database('cloud');
  const bucket = new Bucket();
  const audit = recorder();
  const env = { CLOUD_DB: d1(db), BACKUP: bucket, ...audit };
  try {
    const first = await backupService(env, 'cloud', Date.parse('2026-10-24T18:40:00Z'), async () => {
      throw new Error('unexpected retry');
    });
    assert.equal(first.state, 'ok');
    const preserved = [...bucket.objects].map(([key, object]) => [key, Buffer.from(object.bytes)]);
    assert.equal(preserved.length, 2, 'daily and monthly recovery generations exist');

    const insert = db.prepare("INSERT INTO cloud_folders (id, name, created_by) VALUES (?, 'fixture', 'fixture')");
    db.exec('BEGIN');
    try {
      for (let id = 1; id <= 10001; id++) insert.run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const guarded = await snapshotStatement(env.CLOUD_DB, SERVICES.cloud.tables).all();
    assert.equal(guarded.results[0].allowed, 0, 'global limit must reject 10,001 rows');
    assert.equal(guarded.results[0].rowCount, 10001);
    assert.ok(guarded.results.slice(1).every(row => row.rowJson === null),
      'oversized row bodies must not cross the D1 response boundary');
    await assert.rejects(capture(env.CLOUD_DB, 'cloud'), /SnapshotTooLarge/);

    const second = await backupService(env, 'cloud', Date.parse('2026-10-25T18:40:00Z'), async () => {
      throw new Error('unexpected retry');
    });
    assert.equal(second.state, 'failed');
    const failure = audit.events.findLast(event => event.eventType === 'backup_failed');
    assert.equal(failure?.details.stage, 'capture');
    assert.equal(failure?.details.reason, 'snapshot_too_large');
    assert.equal(failure?.details.attempt, 1, 'permanent overflow must not be retried');
    assert.deepEqual([...bucket.objects.keys()].sort(), preserved.map(([key]) => key).sort());
    for (const [key, bytes] of preserved) assert.deepEqual(Buffer.from(bucket.objects.get(key).bytes), bytes);
    assert.equal([...bucket.objects.keys()].some(key => key.startsWith('attempts/')), false);
  } finally {
    db.close();
  }
});

test('current T-Cloud export exceeds the legacy cap and preserves recovery generations after a partial failure', async () => {
  const db = database('cloud');
  const bucket = new Bucket();
  const env = exportEnv('cloud', d1(db), bucket);
  const now = Date.parse('2026-10-24T18:40:00Z');
  const noSleep = async () => {};
  try {
    const insert = db.prepare("INSERT INTO cloud_folders (id, name, created_by) VALUES (?, 'fixture', 'fixture')");
    db.exec('BEGIN');
    try {
      for (let id = 1; id <= 10001; id++) insert.run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const mock = exportFetcher(db, 'cloud');
    const saved = await saveExport(env, 'cloud', now, { fetcher: mock.fetcher, sleep: noSleep });
    const manifest = (await readExportManifest(bucket, saved.daily, 'cloud')).payload;
    assert.equal(manifest.tables.cloud_folders.rowCount, 10001);
    assert.ok(manifest.parts.length > 1, 'the current format saves bounded parts');
    assert.deepEqual(bucket.objects.get(saved.daily).bytes, bucket.objects.get(saved.monthly).bytes);
    const preserved = [...bucket.objects].map(([key, object]) => [key, Buffer.from(object.bytes)]);
    const writesBeforeFailure = bucket.writes.length;

    // Truncate a later export only after enough valid rows to write new parts.
    const broken = exportFetcher(db, 'cloud', { sql: sqlDump(db, 'cloud') + '\nINSERT INTO cloud_folders VALUES(' });
    await assert.rejects(saveExport(env, 'cloud', Date.parse('2026-11-24T18:40:00Z'), {
      fetcher: broken.fetcher, sleep: noSleep,
    }));
    assert.ok(bucket.writes.length > writesBeforeFailure, 'the failure must exercise cleanup of partial writes');
    assert.deepEqual([...bucket.objects.keys()].sort(), preserved.map(([key]) => key).sort(),
      'no failed generation or unreferenced new parts remain');
    for (const [key, bytes] of preserved) assert.deepEqual(Buffer.from(bucket.objects.get(key).bytes), bytes, key);

    for (const key of [saved.daily, saved.monthly]) {
      const restored = await restoreIsolated(bucket, key, 'cloud');
      try {
        assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM cloud_folders').get().n, 10001);
        assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally {
        restored.db.close();
      }
    }
  } finally {
    db.close();
  }
});
