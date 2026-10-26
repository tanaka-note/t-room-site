import { hashObject, compress, verifiedPut } from '../../backup-worker/src/integrity.js';
import { listObjects } from '../../backup-worker/src/backup.js';

export const PHOTO_VERIFIED_PREFIX = 'media/verified-photos/';
export const PHOTO_RECEIPT_PREFIX = 'media/photo-receipts/';
const VARIANTS = [['original','original_key'],['display','display_key'],['thumbnail','thumbnail_key']];
const SHA = /^[a-f0-9]{64}$/;
const WEEK = 7 * 86400000;
export async function backupPhotos(env, rows, { now = Date.now(), maxObjects = 40, maxBytes = 256 * 1024 * 1024 } = {}) {
  const result = { complete: false, copied: 0, existing: 0, missing: 0, failed: 0, pending: 0, objects: [] };
  if (!rows.length) return { ...result, complete: true };
  if (!env.MEDIA || !env.BACKUP) throw new Error('SourceUnavailable');
  // LIST metadata avoids three HEAD calls for every historical image on every run.
  const [sources, copies, receipts] = await Promise.all([listObjects(env.MEDIA, ''), listObjects(env.BACKUP, PHOTO_VERIFIED_PREFIX), listObjects(env.BACKUP, PHOTO_RECEIPT_PREFIX)]);
  const sourceMap = new Map(sources.map(o=>[o.key,o])), copyMap = new Map(copies.map(o=>[o.key,o]));
  const proofMap = new Map(receipts.map(o=>[o.key,o]));
  const items = rows.flatMap(photo=>VARIANTS.map(([variant,column])=>({ photo, variant, sourceKey: String(photo[column] || ''),
    receiptKey: PHOTO_RECEIPT_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '.json.gz' })));
  items.sort((a,b)=>String(proofMap.get(a.receiptKey)?.customMetadata?.verifiedAt || '').localeCompare(String(proofMap.get(b.receiptKey)?.customMetadata?.verifiedAt || '')));
  let verified = 0, spentBytes = 0;
  const deadline = Date.now() + 90000;
  for (const item of items) {
    const { photo, variant, sourceKey, receiptKey } = item;
    const source = sourceMap.get(sourceKey), receipt = proofMap.get(receiptKey), proof = receipt?.customMetadata || {};
    if (!source) { result.missing++; continue; }
    if (variant === 'original' && Number(photo.original_size) !== source.size) { result.failed++; continue; }
    const copy = copyMap.get(proof.backupKey);
    const sourceProven = proof.format === 'troom-photo-proof-v1' && proof.photoId === String(photo.id) && proof.variant === variant
      && proof.sourceKey === sourceKey && proof.sourceEtag === source.etag && Number(proof.bytes) === source.size && SHA.test(proof.contentSha256 || '');
    const valid = sourceProven && copy?.etag === proof.backupEtag && copy?.size === source.size
      && proof.backupKey.startsWith(PHOTO_VERIFIED_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '/' + proof.contentSha256);
    const record = (key, sha, date) => ({ photoId: String(photo.id), variant, sourceKey, backupKey: key, sha256: sha, bytes: source.size, verifiedAt: date });
    if (valid && now >= Date.parse(proof.verifiedAt) && now - Date.parse(proof.verifiedAt) < WEEK) {
      result.existing++; result.objects.push(record(proof.backupKey, proof.contentSha256, proof.verifiedAt)); continue;
    }
    if (verified >= maxObjects || spentBytes + source.size * 4 > maxBytes || Date.now() >= deadline) { result.pending++; continue; }
    verified++; spentBytes += source.size * 4;
    try {
      const original = await env.MEDIA.get(sourceKey, { onlyIf: { etagMatches: source.etag } });
      if (!original?.body || original.etag !== source.etag) throw new Error('SourceChanged');
      const sha = await hashObject(original);
      if (sourceProven && sha !== proof.contentSha256) throw new Error('VerificationFailed');
      const canonical = PHOTO_VERIFIED_PREFIX + encodeURIComponent(photo.id) + '/' + variant + '/' + sha;
      let key = canonical, existing = await env.BACKUP.get(key);
      // Keep the damaged recovery object for investigation. Do not conceal it
      // with a new receipt while existing generations still reference it.
      if (existing && await hashObject(existing) !== sha) throw new Error('VerificationFailed');
      if (!existing) {
        const body = await env.MEDIA.get(sourceKey, { onlyIf: { etagMatches: source.etag } });
        if (!body?.body || body.etag !== source.etag) throw new Error('SourceChanged');
        const stored = await env.BACKUP.put(key, body.body, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: body.httpMetadata || {} });
        // A concurrent writer can win; independently verify its bytes below.
        if (stored === null && !await env.BACKUP.head(key)) throw new Error('ConcurrentWrite');
      }
      const saved = await env.BACKUP.get(key);
      if (!saved || saved.size !== source.size || await hashObject(saved) !== sha) throw new Error('VerificationFailed');
      const current = await env.MEDIA.head(sourceKey);
      if (!current || current.etag !== source.etag) throw new Error('SourceChanged');
      const verifiedAt = new Date(now).toISOString();
      const metadata = { format: 'troom-photo-proof-v1', photoId: String(photo.id), variant, sourceKey,
        sourceEtag: source.etag, backupKey: key, backupEtag: saved.etag, contentSha256: sha, bytes: String(source.size), verifiedAt };
      await verifiedPut(env.BACKUP, receiptKey, await compress(metadata), metadata,
        receipt ? { etagMatches: receipt.etag } : { etagDoesNotMatch: '*' });
      result.objects.push(record(key, sha, verifiedAt)); result.copied++;
    } catch { result.failed++; }
  }
  result.objects.sort((a,b)=>(a.photoId+'/'+a.variant).localeCompare(b.photoId+'/'+b.variant));
  result.complete = !result.missing && !result.failed && !result.pending;
  result.oldestVerifiedAt = result.objects.map(o=>o.verifiedAt).sort()[0] || null;
  return result;
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
