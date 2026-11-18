import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint } from '../../diary-worker/e2ee/crypto.mjs';
import { createDiaryBackupPayload } from '../../diary-worker/src/backup.js';
import { saveExport } from '../src/export-backup.js';
import { compress, verifiedPut } from '../src/integrity.js';
import { planDiaryArchives, publishDiaryArchive, restoreDiaryArchiveGeneration, sealDiaryArchive,
  verifyDiaryArchive, verifyStoredDiaryArchive } from '../tools/diary-archive.mjs';
import { Bucket, d1, database } from './fixtures.mjs';
import { exportEnv, exportFetcher } from './export-fixtures.mjs';

const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const recoveryPublicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
const expectedRecoveryFingerprint = await fingerprint(recoveryPublicKey);
const sealing = { recoveryPublicKey, expectedRecoveryFingerprint };
const recovery = { recoveryPrivateKey: pair.privateKey, expectedRecoveryFingerprint };
const v3Key = 'monthly/2026-08.json.gz';
const v6Key = 'daily/2026-10-01.json.gz';
const v8Key = 'v8/daily/2026-11-02.json.gz';

async function fixture() {
  const db = database('diary');
  const bucket = new Bucket();
  try {
    db.exec(`INSERT INTO diary_entries (id,entry_date,title,content,author_id,author_name,household_id,status)
      VALUES (1,'2026-08-25','Fixture title','PRIVATE_FIXTURE_CONTENT','main-admin','Fixture owner','tanaka-household','published');
      INSERT INTO diary_photos (id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name)
      VALUES ('fixture-photo',1,'fixture.jpg','image/jpeg',12,'original','display','thumbnail','main-admin','Fixture owner');`);
    for (const [version, date, key] of [[3, '2026-08-25', v3Key], [6, '2026-10-01', v6Key], [8, '2026-11-02', v8Key]]) {
      const payload = await createDiaryBackupPayload(d1(db), Date.parse(`${date}T03:25:00+09:00`));
      payload.formatVersion = version;
      const omit = (table, columns) => {
        const item = payload.tables[table];
        item.columns = item.columns.filter(column => !columns.includes(column));
        for (const row of item.rows) for (const column of columns) delete row[column];
      };
      if (version === 3) omit('diary_entries', ['entry_time', 'last_published_at', 'weather']);
      if (version < 8) {
        omit('diary_photos', ['backup_identity']);
        delete payload.backupScope;
        await bucket.put(key, await compress(payload), { customMetadata: { format: `troom-diary-d1-v${version}` } });
      } else await verifiedPut(bucket, key, await compress(payload), { format: 'troom-diary-d1-v8' });
    }
    const v9 = await saveExport(exportEnv('diary', d1(db), bucket), 'diary', Date.parse('2026-11-03T00:00:00Z'), {
      fetcher: exportFetcher(db, 'diary').fetcher, sleep: async () => {}
    });
    const { objects } = await bucket.list();
    const inventory = objects.map(({ key, etag, size }) => ({ key, etag, size }));
    return { bucket, inventory, v9 };
  } finally { db.close(); }
}

test('all historical formats round-trip through ciphertext readback and isolated SQLite, sharing v9 parts across daily and monthly', async () => {
  const { bucket, inventory, v9 } = await fixture();
  const plan = await planDiaryArchives(bucket, inventory);
  assert.equal(plan.batches.length, 4);
  assert.deepEqual(plan.unreferencedParts, []);
  const shared = plan.batches.find(batch => batch.some(({ key }) => key === v9.daily));
  assert.ok(shared.some(({ key }) => key === v9.monthly));
  assert.equal(shared.filter(({ key }) => key.startsWith('v9/data/')).length,
    inventory.filter(({ key }) => key.startsWith('v9/data/')).length);
  const destination = new Bucket();
  const verified = [];
  for (const batch of plan.batches) {
    const { archive, sourceReport } = await sealDiaryArchive(bucket, batch, sealing);
    assert.doesNotMatch(JSON.stringify(archive), /PRIVATE_FIXTURE_CONTENT|fixture\.jpg|diary_accounts/);
    const receipt = await publishDiaryArchive(destination, archive);
    assert.match(receipt.key, /^sealed\/diary-legacy\/v1\//);
    assert.deepEqual(await publishDiaryArchive(destination, archive), receipt);
    verified.push(await verifyStoredDiaryArchive(destination, receipt, { ...recovery, sourceReport }));
    if (sourceReport.generations.includes(v3Key)) {
      const restored = await restoreDiaryArchiveGeneration(archive, v3Key, recovery);
      try {
        assert.equal(restored.prepare('SELECT content FROM diary_entries WHERE id=1').get().content, 'PRIVATE_FIXTURE_CONTENT');
        assert.equal(restored.prepare('SELECT count(*) AS n FROM diary_accounts WHERE active != 0').get().n, 0);
      } finally { restored.close(); }
    }
  }
  assert.equal(destination.writes.length, 4, 'identical retries do not overwrite archive objects');
  assert.equal(verified.flatMap(r => r.generations).length, 5);
  assert.ok(verified.every(r => r.isolatedRestoreVerified && r.recipientPrivateKeyVerified));
  const provenance = Object.fromEntries(verified.flatMap(r => r.sources).map(source => [source.key, source.verification]));
  assert.equal(provenance[v3Key], 'repeated-source-read');
  assert.equal(provenance[v6Key], 'repeated-source-read');
  assert.equal(provenance[v8Key], 'recorded-sha256');
  assert.deepEqual((await bucket.list()).objects.map(({ key, etag, size }) => ({ key, etag, size })), inventory);
});

test('changed sources, absent v9 parts and a missing v8 source hash stop archiving', async () => {
  const { bucket, inventory, v9 } = await fixture();
  const part = inventory.find(({ key }) => key.startsWith('v9/data/'));
  await assert.rejects(planDiaryArchives(bucket, inventory.filter(source => source !== part)), /DiaryArchivePartMissing/);
  const orphan = `v9/data/${crypto.randomUUID()}/000001.json.gz`;
  const { batches, unreferencedParts } = await planDiaryArchives(bucket, [...inventory, { ...part, key: orphan }]);
  assert.ok(batches.some(batch => batch.some(({ key }) => key === v9.daily)));
  assert.deepEqual(unreferencedParts, [orphan]);
  const batch = inventory.filter(({ key }) => key === v3Key);
  await assert.rejects(sealDiaryArchive(bucket, [{ ...batch[0], etag: 'expired' }], sealing), /DiaryArchiveSourceChanged/);
  let reads = 0;
  const changesDuringRead = { async get(key, options) {
    const object = await bucket.get(key, options);
    if (++reads === 2) object.body = new Blob([new Uint8Array(object.size)]).stream();
    return object;
  } };
  await assert.rejects(sealDiaryArchive(changesDuringRead, batch, sealing), /DiaryArchiveSourceChanged/);
  assert.equal(reads, 2);
  delete bucket.objects.get(v8Key).customMetadata.sha256;
  await assert.rejects(sealDiaryArchive(bucket, inventory.filter(({ key }) => key === v8Key), sealing), /DiaryArchiveSourceHashMissing/);
});

test('trusted key, source report, ciphertext and stored identity must agree', async () => {
  const { bucket, inventory } = await fixture();
  const batch = inventory.filter(({ key }) => key === v6Key);
  await assert.rejects(sealDiaryArchive(bucket, batch, { ...sealing, expectedRecoveryFingerprint: 'A'.repeat(43) }), /UntrustedRecoveryKey/);
  const { archive, sourceReport } = await sealDiaryArchive(bucket, batch, sealing);
  const ciphertext = (archive.ciphertext.startsWith('A') ? 'B' : 'A') + archive.ciphertext.slice(1);
  await assert.rejects(verifyDiaryArchive({ ...archive, ciphertext }, { ...recovery, sourceReport }));
  await assert.rejects(verifyDiaryArchive(archive, { ...recovery, sourceReport: { ...sourceReport, generations: [v3Key] } }), /SourceReportMismatch/);
  const other = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
  await assert.rejects(verifyDiaryArchive(archive, { ...recovery, recoveryPrivateKey: other.privateKey, sourceReport }));
  const destination = new Bucket();
  await assert.rejects(publishDiaryArchive({ async put(...args) {
    await destination.put(...args);
    throw new Error('Fixture lost the write response');
  } }, archive), /lost the write response/);
  const receipt = await publishDiaryArchive(destination, archive);
  assert.equal(destination.writes.length, 1);
  await assert.rejects(publishDiaryArchive(destination, { ...archive, ciphertext }), /ReadbackMismatch/);
  destination.objects.get(receipt.key).bytes[0] ^= 1;
  await assert.rejects(verifyStoredDiaryArchive(destination, receipt, { ...recovery, sourceReport }), /ReadbackMismatch/);
  await assert.rejects(verifyStoredDiaryArchive(destination, { ...receipt, key: `v10/daily/${archive.id}.json` }, { ...recovery, sourceReport }), /DiaryArchiveInvalid/);
});
