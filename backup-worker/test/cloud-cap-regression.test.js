import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, backupService } from '../src/backup.js';
import { snapshotStatement } from '../src/snapshot.js';
import { SERVICES } from '../src/registry.js';
import { database, d1, Bucket, recorder } from './fixtures.mjs';

test('T-Cloud row-cap overflow fails closed and preserves prior recovery generations', async () => {
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
