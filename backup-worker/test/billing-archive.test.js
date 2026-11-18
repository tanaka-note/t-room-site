import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint } from '../../diary-worker/e2ee/crypto.mjs';
import { capture } from '../src/backup.js';
import { saveExport } from '../src/export-backup.js';
import { compress, verifiedPut } from '../src/integrity.js';
import {
  planBillingArchives, publishBillingArchive, restoreBillingArchiveGeneration,
  sealBillingArchive, verifyStoredBillingArchive
} from '../tools/billing-archive.mjs';
import { exportEnv, exportFetcher } from './export-fixtures.mjs';
import { Bucket, d1, database } from './fixtures.mjs';

test('Billing legacy and multipart generations can be sealed, read back, and restored in isolation', async () => {
  const db = database('billing');
  const source = new Bucket(), destination = new Bucket();
  const legacyKey = 'd1/billing/daily/2026-11-01.json.gz';
  const snapshotKey = 'd1/billing/v2/daily/2026-11-01.json.gz';
  const now = Date.parse('2026-11-01T00:00:00Z');
  let exported;
  try {
    db.exec(`INSERT INTO billing_entries
      (id,account_id,document_type,entry_date,category,amount_yen,description,created_by,deleted_at)
      VALUES (7,'chiharu','invoice','2026-10-31','income',-42,'private-fixture','owner','2026-11-01');
      INSERT INTO billing_settlements
      (account_id,settlement_date,direction,method,amount_yen,created_by,legacy_entry_id,deleted_at)
      VALUES ('chiharu','2026-10-31','incoming','unspecified',42,'owner',7,'2026-11-01');
      INSERT INTO billing_opening_balances (account_id,effective_date,balance_yen,updated_by)
      VALUES ('chiharu','2026-10-01',-23,'owner');`);
    const snapshot = await capture(d1(db), 'billing', now);
    await source.put(legacyKey, await compress({ ...snapshot, formatVersion: 1 }));
    await verifiedPut(source, snapshotKey, await compress(snapshot));
    exported = await saveExport(exportEnv('billing', d1(db), source), 'billing', now, {
      fetcher: exportFetcher(db, 'billing').fetcher
    });
  } finally { db.close(); }

  const { objects } = await source.list();
  const inventory = objects.map(({ key, etag, size }) => ({ key, etag, size }));
  const plan = await planBillingArchives(source, inventory);
  assert.equal(plan.batches.length, 3);
  assert.deepEqual(plan.unreferencedParts, []);
  const part = inventory.find(({ key }) => key.includes('/data/'));
  await assert.rejects(planBillingArchives(source, inventory.filter(item => item !== part)), /BillingArchivePartMissing/);
  await assert.rejects(planBillingArchives(source, [...inventory, { ...part, key: 'v9/data/other' }]), /BillingArchiveInventoryInvalid/);
  assert.ok(plan.batches.some(batch => [exported.daily, exported.monthly].every(key => batch.some(object => object.key === key))));

  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
  const recoveryPublicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const expectedRecoveryFingerprint = await fingerprint(recoveryPublicKey);
  const recovery = { recoveryPrivateKey: keys.privateKey, expectedRecoveryFingerprint };
  for (const batch of plan.batches) {
    const { archive, sourceReport } = await sealBillingArchive(source, batch, { recoveryPublicKey, expectedRecoveryFingerprint });
    assert.doesNotMatch(JSON.stringify(archive), /private-fixture|billing_entries|monthly/);
    const receipt = await publishBillingArchive(destination, archive);
    assert.match(receipt.key, /^sealed\/billing-legacy\/v1\//);
    await publishBillingArchive(destination, archive);
    const report = await verifyStoredBillingArchive(destination, receipt, { ...recovery, sourceReport });
    assert.deepEqual(report.generations, sourceReport.generations);
    assert.ok(report.recipientPrivateKeyVerified && report.isolatedRestoreVerified);
    for (const key of report.generations) {
      const restored = await restoreBillingArchiveGeneration(archive, key, recovery);
      try {
        assert.deepEqual({ ...restored.prepare('SELECT id, description, deleted_at FROM billing_entries').get() },
          { id: 7, description: 'private-fixture', deleted_at: '2026-11-01' });
        assert.equal(restored.prepare('SELECT legacy_entry_id FROM billing_settlements').get().legacy_entry_id, 7);
        assert.equal(restored.prepare('SELECT balance_yen FROM billing_opening_balances').get().balance_yen, -23);
        assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM billing_accounts WHERE is_active != 0').get().n, 0);
      } finally { restored.close(); }
    }
    await assert.rejects(verifyStoredBillingArchive(destination, receipt, {
      ...recovery, sourceReport: { ...sourceReport, generations: [] }
    }), /BillingArchiveSourceReportMismatch/);
  }
  assert.equal(destination.writes.length, plan.batches.length);
  assert.deepEqual((await source.list()).objects.map(({ key, etag, size }) => ({ key, etag, size })), inventory);
});
