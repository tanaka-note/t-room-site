import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';

test('principal edits persist with records, recalculate all dates and retain an audit trail in backup', async () => {
  const f = fixture();
  try {
    await f.login();
    const before = await f.state(), requestId = crypto.randomUUID();
    const change = { basePrincipal: 800000, expectedRevision: before.revision, requestId };
    assert.equal((await f.save(before.record, change)).status, 200);
    const after = await f.state();
    assert.equal(after.metadata.basePrincipal, 800000);
    assert.equal(after.report.summary.marketValue, before.report.summary.marketValue);
    assert.equal(after.report.summary.profit, 368000);
    assert.equal(after.report.summary.returnRate, 46);
    assert.deepEqual(after.record, before.record);
    assert.deepEqual(after.history, before.history.map(r => ({ ...r, basePrincipal: 800000 })));
    assert.deepEqual(after.metadata, { ...before.metadata, basePrincipal: 800000 });
    const backup = await (await f.request('/api/backup')).json();
    assert.equal(backup.metadata.basePrincipal, 800000);
    assert.equal(JSON.parse(backup.changes[0].previous_record).basePrincipal, 1000000);
    assert.equal(JSON.parse(backup.changes[0].saved_record).basePrincipal, 800000);
    assert.equal((await f.save(before.record, change)).status, 200, 'exact retry is idempotent');
    assert.equal((await f.save(before.record, { ...change, basePrincipal: 900000 })).status, 409);
    assert.equal((await f.save(before.record)).status, 200, 'old clients can omit principal');
    assert.equal((await f.state()).metadata.basePrincipal, 800000);
  } finally { f.close(); }
});

test('invalid, unauthorized and concurrent principal edits cannot partially change financial data', async () => {
  const f = fixture(), viewer = fixture('viewer');
  try {
    await f.login(); await viewer.login();
    const before = await f.state();
    for (const basePrincipal of [0, -1, 1.5, '800000', null, 1000000000001]) {
      assert.equal((await f.save(before.record, { basePrincipal })).status, 400);
      assert.deepEqual(await f.state(), before);
    }
    assert.equal((await viewer.save(before.record, { basePrincipal: 800000 })).status, 403);
    assert.equal((await f.request('/api/save', { record: before.record, basePrincipal: 800000, expectedRevision: 0, requestId: crypto.randomUUID() }, { Origin: 'https://evil.test' })).status, 403);
    const answers = await Promise.all([800000, 900000].map(basePrincipal => f.save({ ...before.record, time: basePrincipal === 800000 ? '01:00' : '02:00' }, { basePrincipal, expectedRevision: 0 })));
    assert.deepEqual(answers.map(r => r.status).sort(), [200, 409]);
    const after = await f.state(), winner = answers[0].status === 200 ? 800000 : 900000;
    assert.equal(after.revision, 1);
    assert.equal(after.metadata.basePrincipal, winner);
    assert.equal(after.record.time, winner === 800000 ? '01:00' : '02:00');
    const backup = await (await f.request('/api/backup')).json();
    assert.equal(backup.changes.length, 1);
    assert.equal(JSON.parse(backup.changes[0].saved_record).basePrincipal, winner);
  } finally { f.close(); viewer.close(); }
});
