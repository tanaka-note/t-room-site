import { compress, verifiedGeneration, verifiedPut } from './integrity.js';

// One service may publish/prune at a time, including overlapping delayed jobs.
// The lease outlives a 15-minute Workflow step. No unconditional lock deletion.
export async function withExportLease(bucket, service, action, clock = Date.now) {
  const key = `_metadata/d1-export-lock/${service}.json.gz`;
  const validate = p => {
    if (p?.format !== 'd1-export-lease-v1' || typeof p.owner !== 'string' || !Number.isSafeInteger(p.until)) throw new Error('VerificationFailed');
  };
  const prior = await verifiedGeneration(bucket, key, validate);
  if (prior && prior.payload.until > clock()) throw new Error('ConcurrentWrite');
  const owner = crypto.randomUUID(), until = clock() + 20 * 60000;
  await verifiedPut(bucket, key, await compress({ format: 'd1-export-lease-v1', owner, until }), {}, prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' });
  const guard = async () => {
    const current = await verifiedGeneration(bucket, key, validate);
    if (!current || current.payload.owner !== owner || current.payload.until <= clock()) throw new Error('ConcurrentWrite');
    return current;
  };
  try { return await action(guard); }
  finally {
    try {
      const current = await guard();
      await verifiedPut(bucket, key, await compress({ format: 'd1-export-lease-v1', owner, until: 0 }), {}, { etagMatches: current.etag });
    } catch { /* Expired/stolen leases are never released by their old owner. */ }
  }
}
