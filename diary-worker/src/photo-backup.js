import { hashObject, compress, verifiedPut, verifiedGeneration, digest } from '../../backup-worker/src/integrity.js';

export const PHOTO_VERIFIED_PREFIX = 'media/verified-photos/';
export const PHOTO_RECEIPT_PREFIX = 'media/photo-receipts/';
export const PHOTO_VERSION_PREFIX = 'media/photo-versions/';
export const PHOTO_ISSUE_PREFIX = 'media/photo-issues/';
export const PHOTO_REVERIFY_MS = 30 * 86400000;
export const VARIANTS = [['original','original_key'],['display','display_key'],['thumbnail','thumbnail_key']];
const SHA = /^[a-f0-9]{64}$/;
const shaText = text => digest(new TextEncoder().encode(text));

export const photoReference = (photo, variant) => shaText(JSON.stringify([
  String(photo.id), photo.created_at ?? null, Number(photo.original_size),
  photo.original_key, photo.display_key, photo.thumbnail_key, variant
]));
const receiptKey = (photo, variant) => PHOTO_RECEIPT_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '.json.gz';
const issueKey = (photo, variant) => PHOTO_ISSUE_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '.json.gz';

function validateProof(p, photo, variant) {
  if (!['troom-photo-proof-v1','troom-photo-proof-v2'].includes(p?.format)
    || p.photoId !== String(photo.id) || p.variant !== variant || !SHA.test(p.contentSha256 || '')
    || p.backupKey !== PHOTO_VERIFIED_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '/' + p.contentSha256
    || !Number.isSafeInteger(Number(p.bytes)) || Number(p.bytes) < 0 || !p.sourceEtag || !p.backupEtag
    || !Number.isFinite(Date.parse(p.verifiedAt))) throw new Error('CorruptPhoto');
}
async function saveVersion(bucket, proof, photo, variant) {
  const referenceSha256 = await photoReference(photo, variant);
  const p = { ...proof, format: 'troom-photo-proof-v2', referenceSha256 };
  const key = PHOTO_VERSION_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '/' + referenceSha256 + '/' + await shaText(p.sourceEtag) + '.json.gz';
  const validate = value => {
    validateProof(value, photo, variant);
    if (value.referenceSha256 !== referenceSha256 || value.contentSha256 !== p.contentSha256
      || value.sourceEtag !== p.sourceEtag || value.sourceKey !== p.sourceKey) throw new Error('CorruptPhoto');
  };
  const prior = await verifiedGeneration(bucket, key, validate);
  if (!prior) {
    try { await verifiedPut(bucket, key, await compress(p), p, { etagDoesNotMatch: '*' }); }
    catch (error) { if (error.message !== 'ConcurrentWrite' || !await verifiedGeneration(bucket, key, validate)) throw error; }
  }
  return p;
}

// One sequential, streamed object operation. The caller owns the bounded work
// budget and durable cursor; no bucket-wide LIST or all-photo allocation here.
export async function processPhoto(env, photo, variant, column, budget) {
  const sourceKey = String(photo[column] || '');
  const key = receiptKey(photo, variant), brokenKey = issueKey(photo, variant);
  const base = { photoId: String(photo.id), variant, sourceKey };
  if (await env.BACKUP.head(brokenKey)) return { ...base, state: 'corrupt' };
  let receipt, proof;
  try {
    receipt = await verifiedGeneration(env.BACKUP, key, p => validateProof(p, photo, variant));
    proof = receipt?.payload;
    // Preserve evidence even when a changed source would produce a new hash.
    if (proof) {
      const copy = await env.BACKUP.head(proof.backupKey);
      if (!copy || copy.etag !== proof.backupEtag || copy.size !== Number(proof.bytes)) throw new Error('CorruptPhoto');
    }
    const source = await env.MEDIA.head(sourceKey);
    if (!source) return { ...base, state: 'missing' };
    if (variant === 'original' && source.size !== Number(photo.original_size)) return { ...base, state: 'failed' };
    const same = proof?.sourceKey === sourceKey && proof.sourceEtag === source.etag && Number(proof.bytes) === source.size;
    const due = same && (budget.now < Date.parse(proof.verifiedAt) || budget.now - Date.parse(proof.verifiedAt) >= PHOTO_REVERIFY_MS);
    if (same && (budget.mode === 'copy' || !due)) {
      if (budget.mode === 'copy') await saveVersion(env.BACKUP, proof, photo, variant);
      return { ...base, state: due ? 'verification_pending' : 'verified', bytes: source.size,
        backupKey: proof.backupKey, sha256: proof.contentSha256, verifiedAt: proof.verifiedAt };
    }
    if (budget.mode === 'verify' && !same) return { ...base, state: 'pending' };
    if (source.size * 6 > budget.maxBytes) return { ...base, state: 'failed', reason: 'object_too_large' };
    // Six object lengths conservatively covers hashing, copy, concurrent-winner
    // validation and readback. It is an I/O budget, never a memory allocation.
    if (budget.objects >= budget.maxObjects || budget.bytes + source.size * 6 > budget.maxBytes || budget.clock() >= budget.deadline)
      return { ...base, state: 'deferred' };
    budget.objects++; budget.bytes += source.size * 6;
    const original = await env.MEDIA.get(sourceKey, { onlyIf: { etagMatches: source.etag } });
    if (!original?.body || original.etag !== source.etag || original.size !== source.size) throw new Error('SourceChanged');
    const sha = await hashObject(original);
    if (same && sha !== proof.contentSha256) throw new Error('CorruptPhoto');
    const backupKey = PHOTO_VERIFIED_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '/' + sha;
    const existing = await env.BACKUP.get(backupKey);
    if (existing && (existing.size !== source.size || await hashObject(existing) !== sha)) throw new Error('CorruptPhoto');
    let copied = false;
    if (!existing) {
      if (same) throw new Error('CorruptPhoto');
      const body = await env.MEDIA.get(sourceKey, { onlyIf: { etagMatches: source.etag } });
      if (!body?.body || body.etag !== source.etag) throw new Error('SourceChanged');
      const stored = await env.BACKUP.put(backupKey, body.body, { onlyIf: { etagDoesNotMatch: '*' }, sha256: sha, httpMetadata: body.httpMetadata || {} });
      copied = stored !== null;
    }
    const saved = await env.BACKUP.get(backupKey);
    if (!saved || saved.size !== source.size || await hashObject(saved) !== sha) throw new Error('CorruptPhoto');
    const current = await env.MEDIA.head(sourceKey);
    if (!current || current.etag !== source.etag || current.size !== source.size) throw new Error('SourceChanged');
    if (budget.clock() >= budget.leaseUntil) throw new Error('ConcurrentWrite');
    let metadata = { format: 'troom-photo-proof-v2', photoId: String(photo.id), variant, sourceKey,
      sourceEtag: source.etag, backupKey, backupEtag: saved.etag, contentSha256: sha, bytes: String(source.size), verifiedAt: new Date(budget.now).toISOString() };
    metadata = await saveVersion(env.BACKUP, metadata, photo, variant);
    if (budget.clock() >= budget.leaseUntil) throw new Error('ConcurrentWrite');
    await verifiedPut(env.BACKUP, key, await compress(metadata), metadata, receipt ? { etagMatches: receipt.etag } : { etagDoesNotMatch: '*' });
    return { ...base, state: 'verified', copied, reverified: same, bytes: source.size, backupKey, sha256: sha, verifiedAt: metadata.verifiedAt };
  } catch (error) {
    const corrupt = ['CorruptPhoto','VerificationFailed','LegacyGenerationUnverified'].includes(error.message);
    if (corrupt) {
      // A sticky, create-only incident survives retries and source changes. No
      // automatic repair, receipt replacement or removal of damaged copies.
      const marker = { format: 'troom-photo-incident-v1', reason: 'verification_failed', at: new Date(budget.now).toISOString() };
      try { await verifiedPut(env.BACKUP, brokenKey, await compress(marker), marker, { etagDoesNotMatch: '*' }); }
      catch (failure) { if (failure.message !== 'ConcurrentWrite') throw failure; }
    }
    return { ...base, state: corrupt ? 'corrupt' : 'failed' };
  }
}

export function photoBudget({ now = Date.now(), mode = 'copy', maxObjects = 40, maxBytes = 256 * 1024 * 1024, clock = Date.now, maxMs = 90000, leaseUntil = Infinity } = {}) {
  if (!['copy','verify'].includes(mode) || !Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > 40
    || !Number.isFinite(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 || maxMs < 0 || maxMs > 90000) throw new Error('InvalidPhotoBudget');
  return { now, mode, maxObjects, maxBytes, clock, deadline: clock() + maxMs, leaseUntil, objects: 0, bytes: 0 };
}
export async function backupPhotos(env, rows, options = {}) {
  if (rows.length > 40) throw new Error('PhotoPageTooLarge');
  const budget = photoBudget(options);
  const result = { complete: false, copied: 0, existing: 0, missing: 0, failed: 0, corrupt: 0, pending: 0, verificationPending: 0, objects: [] };
  for (const photo of rows) for (const [variant,column] of VARIANTS) {
    const item = await processPhoto(env, photo, variant, column, budget);
    if (['verified','verification_pending'].includes(item.state)) {
      result[item.copied ? 'copied' : 'existing']++; if (item.state === 'verification_pending') result.verificationPending++;
      result.objects.push(item);
    } else result[({ deferred: 'pending', pending: 'pending' })[item.state] || item.state]++;
  }
  return { ...result, complete: !result.missing && !result.failed && !result.corrupt && !result.pending };
}

// Explicit offline pairing for a v8 D1 snapshot. Source references must match;
// timestamps alone cannot choose between in-place edits of the same R2 key.
export async function resolvePhotoManifest(bucket, payload) {
  if (payload.formatVersion !== 8 || payload.backupScope !== 'd1-only') throw new Error('Unsupported diary backup format');
  const objects = [];
  for (const photo of payload.tables.diary_photos.rows) for (const [variant,column] of VARIANTS) {
    const ref = await photoReference(photo, variant);
    const prefix = PHOTO_VERSION_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '/' + ref + '/';
    const page = await bucket.list({ prefix, limit: 2 });
    if (page.truncated || page.objects.length > 1) throw new Error('AmbiguousMediaVersion');
    if (!page.objects.length) throw new Error('MediaManifestIncomplete');
    const generation = await verifiedGeneration(bucket, page.objects[0].key, p => {
      validateProof(p, photo, variant);
      if (p.referenceSha256 !== ref || p.sourceKey !== photo[column] || (variant === 'original' && Number(p.bytes) !== Number(photo.original_size))) throw new Error('MediaManifestInvalid');
    });
    const p = generation.payload;
    if (await bucket.head(issueKey(photo, variant))) throw new Error('CorruptPhoto');
    objects.push({ photoId: String(photo.id), variant, sourceKey: p.sourceKey, backupKey: p.backupKey, bytes: Number(p.bytes), sha256: p.contentSha256, verifiedAt: p.verifiedAt });
  }
  const paired = { ...payload, mediaBackup: { complete: true, objects } };
  validatePhotoManifest(paired);
  return paired;
}

export function validatePhotoManifest(payload) {
  // Legacy photographs have no independent checksum oracle: keep them, but do
  // not silently certify or restore them merely because an object exists.
  const objects = payload.mediaBackup?.objects;
  if (Number(payload.formatVersion) < 7 || !Array.isArray(objects)) throw new Error('LegacyMediaUnverified');
  const expected = payload.tables.diary_photos.rows.flatMap(photo=>VARIANTS.map(([variant,column])=>({ photo, variant, key: String(photo[column] || '') })));
  if (objects.length !== expected.length) throw new Error('MediaManifestInvalid');
  const manifest = new Map(objects.map(o=>[o.photoId+'/'+o.variant,o]));
  for (const {photo,variant,key} of expected) {
    const item=manifest.get(photo.id+'/'+variant);
    const base=PHOTO_VERIFIED_PREFIX+encodeURIComponent(photo.id)+'/'+variant+'/';
    if(!item || item.sourceKey!==key || !SHA.test(item.sha256) || item.backupKey!==base+item.sha256
      || !Number.isSafeInteger(item.bytes) || item.bytes<0 || !Number.isFinite(Date.parse(item.verifiedAt))) throw new Error('MediaManifestInvalid');
  }
  return {expected,manifest};
}
export async function restorePhotos(env, payload) {
  const {expected,manifest}=validatePhotoManifest(payload);
  const result = { complete: false, restored: 0, existing: 0, missing: 0, failed: 0 };
  for (const { photo, variant, key } of expected) {
    const item = manifest.get(photo.id+'/'+variant);
    try {
      const existing = await env.MEDIA.get(key);
      if (existing) {
        if (await hashObject(existing) !== item.sha256) throw new Error('DestinationMismatch');
        result.existing++; continue;
      }
      const backup = await env.BACKUP.get(item.backupKey);
      if (!backup) { result.missing++; continue; }
      if (backup.size !== item.bytes || await hashObject(backup) !== item.sha256) throw new Error('VerificationFailed');
      const source = await env.BACKUP.get(item.backupKey);
      if (!source?.body || source.etag !== backup.etag) throw new Error('SourceChanged');
      await env.MEDIA.put(key, source.body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: source.httpMetadata || {} });
      const restored = await env.MEDIA.get(key);
      if (!restored || await hashObject(restored) !== item.sha256) throw new Error('VerificationFailed');
      result.restored++;
    } catch { result.failed++; }
  }
  return { ...result, complete: !result.missing && !result.failed };
}
