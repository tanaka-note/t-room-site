export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
let busy = false;
// A Worker isolate's heap limit is shared by concurrent invocations. R2 CAS
// still arbitrates across isolates; this guard bounds heavy local work only.
export async function withBackupLock(work) {
  if (busy) throw new Error('ConcurrentWrite');
  busy = true;
  try { return await work(); } finally { busy = false; }
}
export async function readBounded(stream, max = MAX_OBJECT_BYTES) {
  const reader = stream.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error('SnapshotTooLarge'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
export async function hashObject(object) {
  if (!object?.body) throw new Error('VerificationFailed');
  if (crypto.DigestStream) {
    const sink = new crypto.DigestStream('SHA-256');
    await object.body.pipeTo(sink);
    return hex(await sink.digest);
  }
  // Node fixture fallback. Production Workers use DigestStream without buffering photos.
  return digest(await readBounded(object.body));
}
export const objectBytes = object => readBounded(object.body);
export async function compress(value) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_OBJECT_BYTES) throw new Error('SnapshotTooLarge');
  return readBounded(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')));
}
export async function decode(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))));
}
export async function verifiedPut(bucket, key, bytes, customMetadata = {}, onlyIf = undefined) {
  if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error('SnapshotTooLarge');
  const sha256 = await digest(bytes);
  const stored = await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' }, customMetadata: { ...customMetadata, sha256 }, ...(onlyIf ? { onlyIf } : {}) });
  if (stored === null) throw new Error('ConcurrentWrite');
  const copy = await bucket.get(key);
  if (!copy || await hashObject(copy) !== sha256) throw new Error('VerificationFailed');
  return sha256;
}
export async function verifiedGeneration(bucket, key, validate) {
  const object = await bucket.get(key); if (!object) return null;
  if (!/^[a-f0-9]{64}$/.test(object.customMetadata?.sha256 || '')) throw new Error('LegacyGenerationUnverified');
  const bytes = await objectBytes(object);
  if (await digest(bytes) !== object.customMetadata.sha256) throw new Error('VerificationFailed');
  const payload = await decode(bytes); await validate(payload);
  return { bytes, payload, sha256: object.customMetadata.sha256, etag: object.etag };
}
export async function publishGeneration(bucket, key, bytes, metadata, validate) {
  // CAS only: even a damaged or old-format object is never overwritten.
  const prior = await verifiedGeneration(bucket, key, validate);
  if (prior) return { ...prior, created: false };
  await validate(await decode(bytes));
  const candidate = `attempts/${crypto.randomUUID()}.json.gz`;
  try {
    await verifiedPut(bucket, candidate, bytes, metadata, { etagDoesNotMatch: '*' });
    try { await verifiedPut(bucket, key, bytes, metadata, { etagDoesNotMatch: '*' }); }
    catch (error) {
      if (error.message !== 'ConcurrentWrite') throw error;
      const winner = await verifiedGeneration(bucket, key, validate);
      if (!winner) throw new Error('VerificationFailed');
      return { ...winner, created: false };
    }
    return { bytes, payload: await decode(bytes), sha256: await digest(bytes), created: true };
  } finally { try { await bucket.delete(candidate); } catch {} }
}
