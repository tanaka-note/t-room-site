// Run on the administrator's trusted device. The source interface only reads.
import { isDeepStrictEqual } from 'node:util';
import {
  RECOVERY_RECIPIENT, b64, encode, fingerprint, newKey, openRecipientKey,
  recipientKeyBox, unb64, validatePublicKey
} from '../../diary-worker/e2ee/crypto.mjs';
import { readExportManifest } from '../src/export-backup.js';
import { digest, readBounded } from '../src/integrity.js';
import { restoreIsolated } from './restore-isolated.mjs';

const maxSourceBytes = 8 * 1024 * 1024;
const maxPayloadBytes = 16 * 1024 * 1024;
const maxCiphertextLength = Math.ceil((maxPayloadBytes + 16) * 4 / 3);
const maxArchiveBytes = maxCiphertextLength + 4096;
const maxObjects = 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const isMetadata = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every(item => typeof item === 'string');

export function createLegacyArchive(profile) {
  const { service, format, destinationPrefix, exportPrefix, generationKey, partKey, requireRecordedHash, verifyRestored } = profile;
  const error = code => new Error(profile.errorPrefix + code);

  function sourceMap(inventory) {
    if (!Array.isArray(inventory) || !inventory.length) throw error('InventoryInvalid');
    const sources = new Map();
    for (const { key, etag, size } of inventory) {
      if (typeof key !== 'string' || (!generationKey.test(key) && !partKey.test(key)) || sources.has(key)
        || typeof etag !== 'string' || !etag || etag.length > 128
        || !Number.isSafeInteger(size) || size < 1 || size > maxSourceBytes) throw error('InventoryInvalid');
      sources.set(key, { key, etag, size });
    }
    return sources;
  }

  async function readSource(bucket, source) {
    async function read() {
      const object = await bucket.get(source.key, { onlyIf: { etagMatches: source.etag } });
      if (!object?.body || object.etag !== source.etag || object.size !== source.size) throw error('SourceChanged');
      const metadata = object.customMetadata ?? {};
      if (!isMetadata(metadata)) throw error('SourceChanged');
      const bytes = await readBounded(object.body, source.size);
      if (bytes.length !== source.size) throw error('SourceChanged');
      return { bytes, metadata: { ...metadata }, sha256: await digest(bytes) };
    }
    const first = await read();
    try {
      const recorded = first.metadata.sha256;
      if (recorded !== undefined) {
        if (recorded !== first.sha256) throw error('SourceHashMismatch');
      } else {
        // Pre-verification v3/v6 files have no original digest. A repeated read
        // pins migration to the current object; it cannot attest to older bytes.
        if (requireRecordedHash(source.key)) throw error('SourceHashMissing');
        const second = await read();
        try {
          if (second.sha256 !== first.sha256 || !isDeepStrictEqual(second.metadata, first.metadata)) throw error('SourceChanged');
        } finally { second.bytes.fill(0); }
      }
      return { ...source, ...first };
    } catch (error) {
      first.bytes.fill(0);
      throw error;
    }
  }

  function memoryBucket(objects) {
    return { async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      // Supply a verified migration digest to the isolated reader for older
      // objects while preserving their original metadata in the archive itself.
      return { body: new Blob([object.bytes]).stream(), etag: object.etag,
        customMetadata: { ...object.metadata, sha256: object.sha256 } };
    } };
  }

  async function exportPartKeys(bucket, key) {
    const { payload } = await readExportManifest(bucket, key, service, false);
    return payload.parts.map(part => part.key).sort();
  }

  /** Inventory entries are the key, size and ETag from the same R2 listing. */
  async function planArchives(bucket, inventory) {
    const sources = sourceMap(inventory);
    const batches = [], byParts = new Map(), referenced = new Set();
    for (const key of [...sources.keys()].sort().filter(value => generationKey.test(value))) {
      if (!key.startsWith(exportPrefix)) {
        batches.push([sources.get(key)]);
        continue;
      }
      const manifest = await readSource(bucket, sources.get(key));
      try {
        const keys = await exportPartKeys(memoryBucket(new Map([[key, manifest]])), key);
        const identity = JSON.stringify(keys);
        if (!byParts.has(identity)) {
          const parts = keys.map(part => {
            if (!sources.has(part)) throw error('PartMissing');
            referenced.add(part);
            return sources.get(part);
          });
          byParts.set(identity, parts);
          batches.push(parts);
        }
        byParts.get(identity).push(sources.get(key));
      } finally { manifest.bytes.fill(0); }
    }
    if (!batches.length) throw error('GenerationMissing');
    const unreferencedParts = [...sources.keys()].filter(key => partKey.test(key) && !referenced.has(key)).sort();
    return { batches, unreferencedParts };
  }

  function sourceSummary(objects) {
    return [...objects.values()].map(({ key, etag, size, sha256, metadata }) => ({
      key, etag, size, sha256, verification: metadata.sha256 ? 'recorded-sha256' : 'repeated-source-read'
    })).sort((a, b) => a.key.localeCompare(b.key));
  }

  async function restoreGeneration(bucket, key) {
    const { db, payload } = await restoreIsolated(bucket, key, service);
    try {
      verifyRestored(db, payload, key);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async function rehearse(objects) {
    const bucket = memoryBucket(objects);
    const generationKeys = [...objects.keys()].filter(key => generationKey.test(key)).sort();
    if (!generationKeys.length) throw error('GenerationMissing');
    const referenced = new Set(generationKeys);
    for (const key of generationKeys) {
      if (key.startsWith(exportPrefix)) for (const part of await exportPartKeys(bucket, key)) referenced.add(part);
      const db = await restoreGeneration(bucket, key);
      db.close();
    }
    if (objects.size !== referenced.size || [...referenced].some(key => !objects.has(key))) throw error('ReferenceMismatch');
    return generationKeys;
  }

  const binding = id => ({ household: 'recovery', scope: `${service}-backup-archive`, id, revision: 1, epoch: 1, kind: 'backup-archive' });

  function header(archive) {
    const { format: type, version, id, recipientFingerprint } = archive;
    if (type !== format || version !== 1 || !uuid.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(recipientFingerprint)
      || Object.keys(archive).sort().join(',') !== 'ciphertext,format,id,iv,keyBox,recipientFingerprint,version'
      || Object.keys(archive.keyBox ?? {}).join(',') !== RECOVERY_RECIPIENT
      || !/^(?:[A-Za-z0-9_-]{512}|[A-Za-z0-9_-]{683})$/.test(archive.keyBox[RECOVERY_RECIPIENT])
      || !/^[A-Za-z0-9_-]{16}$/.test(archive.iv) || typeof archive.ciphertext !== 'string'
      || archive.ciphertext.length > maxCiphertextLength || !/^[A-Za-z0-9_-]+$/.test(archive.ciphertext)) throw error('Invalid');
    return { format: type, version, id, recipientFingerprint };
  }

  function assertBatchSize(sources) {
    if (sources.size > maxObjects || [...sources.values()].reduce((total, source) => total + source.size, 0) > maxSourceBytes) {
      throw error('BatchTooLarge');
    }
  }

  async function sealArchive(bucket, batch, { recoveryPublicKey, expectedRecoveryFingerprint }) {
    validatePublicKey(recoveryPublicKey, 'recovery');
    const recipientFingerprint = await fingerprint(recoveryPublicKey);
    if (recipientFingerprint !== expectedRecoveryFingerprint) throw new Error('UntrustedRecoveryKey');
    const sources = sourceMap(batch);
    assertBatchSize(sources);
    const objects = new Map();
    let plaintext;
    try {
      for (const [key, source] of sources) objects.set(key, await readSource(bucket, source));
      const generations = await rehearse(objects);
      const key = await newKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const identity = { format, version: 1, id: crypto.randomUUID(), recipientFingerprint };
      plaintext = encode([...objects.values()].map(({ bytes, ...object }) => ({ ...object, body: b64(bytes) })));
      if (plaintext.length > maxPayloadBytes) throw error('BatchTooLarge');
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode(identity) }, key, plaintext);
      const keyBox = await recipientKeyBox(key, binding(identity.id), [], recoveryPublicKey);
      return { archive: { ...identity, iv: b64(iv), ciphertext: b64(ciphertext), keyBox },
        sourceReport: { generations, sources: sourceSummary(objects) } };
    } finally {
      plaintext?.fill(0);
      for (const { bytes } of objects.values()) bytes.fill(0);
    }
  }

  async function openArchiveObjects(archive, { recoveryPrivateKey, expectedRecoveryFingerprint }) {
    const identity = header(archive);
    if (identity.recipientFingerprint !== expectedRecoveryFingerprint) throw new Error('UntrustedRecoveryKey');
    const iv = unb64(archive.iv, 16);
    const key = await openRecipientKey(archive.keyBox, binding(identity.id), RECOVERY_RECIPIENT, recoveryPrivateKey);
    const ciphertext = unb64(archive.ciphertext, maxCiphertextLength);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encode(identity) }, key, ciphertext));
    const objects = new Map();
    try {
      if (plaintext.length > maxPayloadBytes) throw error('BatchTooLarge');
      const rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      const sources = sourceMap(rows);
      assertBatchSize(sources);
      for (const row of rows) {
        const bytes = unb64(row.body, Math.ceil(row.size * 4 / 3));
        objects.set(row.key, { ...sources.get(row.key), sha256: row.sha256, metadata: row.metadata, bytes });
        if (bytes.length !== row.size || !sha256.test(row.sha256) || await digest(bytes) !== row.sha256
          || !isMetadata(row.metadata) || row.metadata.sha256 !== undefined && row.metadata.sha256 !== row.sha256) throw error('SourceHashMismatch');
      }
      return objects;
    } catch (error) {
      for (const { bytes } of objects.values()) bytes.fill(0);
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  async function verifyArchive(archive, options) {
    const objects = await openArchiveObjects(archive, options);
    try {
      const actual = { generations: await rehearse(objects), sources: sourceSummary(objects) };
      if (!isDeepStrictEqual(actual, options.sourceReport)) throw error('SourceReportMismatch');
      return { ...actual, recipientPrivateKeyVerified: true, isolatedRestoreVerified: true };
    } finally {
      for (const { bytes } of objects.values()) bytes.fill(0);
    }
  }

  /** Return an isolated in-memory SQLite database. The caller must close it. */
  async function restoreArchiveGeneration(archive, key, options) {
    if (!generationKey.test(key)) throw error('GenerationMissing');
    const objects = await openArchiveObjects(archive, options);
    try {
      if (!objects.has(key)) throw error('GenerationMissing');
      return await restoreGeneration(memoryBucket(objects), key);
    } finally {
      for (const { bytes } of objects.values()) bytes.fill(0);
    }
  }

  async function readSealedArchive(destination, { key, sha256: expectedDigest }) {
    const stored = await destination.get(key);
    if (!stored?.body || stored.customMetadata?.sha256 !== expectedDigest) throw error('ReadbackMismatch');
    const bytes = await readBounded(stored.body, maxArchiveBytes);
    if (await digest(bytes) !== expectedDigest) throw error('ReadbackMismatch');
    return bytes;
  }

  /** Retry with the same sealed archive. Existing objects must match exactly. */
  async function publishArchive(destination, archive) {
    const { id } = header(archive);
    const bytes = encode(archive);
    if (bytes.length > maxArchiveBytes) throw error('BatchTooLarge');
    const receipt = { key: `${destinationPrefix}${id}.json`, sha256: await digest(bytes) };
    await destination.put(receipt.key, bytes, { onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' }, customMetadata: { format, sha256: receipt.sha256 } });
    await readSealedArchive(destination, receipt);
    return receipt;
  }

  /** Read back the immutable R2 object before checking it with the recovery key. */
  async function verifyStoredArchive(destination, receipt, options) {
    const id = receipt.key?.slice(destinationPrefix.length, -5);
    if (!uuid.test(id) || receipt.key !== `${destinationPrefix}${id}.json` || !sha256.test(receipt.sha256)) {
      throw error('Invalid');
    }
    const bytes = await readSealedArchive(destination, receipt);
    const archive = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (archive.id !== id) throw error('ReadbackMismatch');
    return verifyArchive(archive, options);
  }

  return { planArchives, sealArchive, verifyArchive, restoreArchiveGeneration, publishArchive, verifyStoredArchive };
}
