import { compress, verifiedPut, verifiedGeneration } from '../../backup-worker/src/integrity.js';
import { reportRun } from '../../backup-worker/src/monitor.js';
import { processPhoto, photoBudget, bindPhotoIdentity, VARIANTS } from './photo-backup.js';

export const PHOTO_STATE_PREFIX = '_metadata/diary-photos/';
export const PHOTO_COPY_CRON = '55 18 * * *'; // 03:55 JST
export const PHOTO_VERIFY_CRON = '45 0-2,19-23 * * *'; // 04:45..11:45 JST
export const PHOTO_CATCHUP_CRON = '5,15,25,35,55 19,20 * * *'; // at most ten/day
const LEASE_MS = 5 * 60000;
const CATCHUP_MS = 14 * 86400000;
const columns = 'id,original_size,original_key,display_key,thumbnail_key,created_at,backup_identity';
const emptyCounts = () => ({ scanned: 0, backedUp: 0, pending: 0, verificationPending: 0, failed: 0, corrupt: 0, oversized: 0, missing: 0, bytes: 0 });
const MAX_RETRIES = 256;
const RETRIES_PER_BATCH = 8;
const validState = p => { if (p?.format !== 'troom-photo-job-v1') throw new Error('PhotoStateInvalid'); };
const readState = (bucket, key) => verifiedGeneration(bucket, key, validState);
async function createRecord(bucket, key, data) {
  await verifiedPut(bucket, key, await compress(data), { format: data.format }, { etagDoesNotMatch: '*' });
}

async function acquireLease(bucket, clock) {
  const key = PHOTO_STATE_PREFIX + 'lease.json.gz';
  const prior = await readState(bucket, key);
  if (prior && prior.payload.until > clock()) return null;
  const until = clock() + LEASE_MS;
  try {
    await verifiedPut(bucket, key, await compress({ format: 'troom-photo-job-v1', until, owner: crypto.randomUUID() }), {}, prior ? { etagMatches: prior.etag } : { etagDoesNotMatch: '*' });
    return until;
  } catch (e) { if (e.message === 'ConcurrentWrite') return null; throw e; }
}

// R2 receipts are durable per object; the cursor is checkpointed once per batch.
// A hard stop replays at most one batch, reusing valid receipts without copying.
export async function runPhotoBatch(env, { now = Date.now(), mode = 'copy', catchup = false, clock = Date.now, maxScanItems = 120, onStart = async () => {}, ...limits } = {}) {
  const started = clock();
  if (!env.DB || !env.MEDIA || !env.BACKUP) throw new Error('SourceUnavailable');
  if (!Number.isInteger(maxScanItems) || maxScanItems < 3 || maxScanItems > 120) throw new Error('InvalidPhotoBudget');
  const bucket = env.BACKUP, key = PHOTO_STATE_PREFIX + mode + '.json.gz';
  const saved = await readState(bucket, key);
  const state = saved?.payload || { format: 'troom-photo-job-v1', cursor: null, counts: emptyCounts() };
  state.counts = { ...emptyCounts(), ...state.counts };
  state.retries ??= [];
  if (!Array.isArray(state.retries) || state.retries.length > MAX_RETRIES) throw new Error('PhotoStateInvalid');
  if (!state.cursor) { state.counts = emptyCounts(); state.cycleStartedAt = new Date(now).toISOString(); state.cycleId = crypto.randomUUID(); }
  state.cycleId ??= crypto.randomUUID();
  const windowKey = PHOTO_STATE_PREFIX + 'migration-window.json.gz';
  let window = await readState(bucket, windowKey);
  if (catchup && (!window || now < window.payload.startedAt || now >= window.payload.startedAt + CATCHUP_MS || clock() >= window.payload.startedAt + CATCHUP_MS || state.initialCatchupComplete)) return { skipped: true };
  const leaseUntil = await acquireLease(bucket, clock);
  if (!leaseUntil) return { skipped: true, reason: 'concurrent_write' };
  if (!window) {
    await createRecord(bucket, windowKey, { format: 'troom-photo-job-v1', startedAt: now });
    window = { payload: { startedAt: now } };
  }
  if (catchup) {
    const scheduled = new Date(now), minute = scheduled.getUTCMinutes(), hour = scheduled.getUTCHours();
    if (![19,20].includes(hour) || ![5,15,25,35,55].includes(minute)) throw new Error('InvalidCatchupSlot');
    const slot = PHOTO_STATE_PREFIX + 'catchup-slots/' + scheduled.toISOString().slice(0,16).replaceAll(':','-') + '.json.gz';
    try { await createRecord(bucket, slot, { format: 'troom-photo-job-v1', at: now }); }
    catch (e) { if (e.message === 'ConcurrentWrite') return { skipped: true }; throw e; }
  }
  await onStart();
  const budget = photoBudget({ ...limits, now, mode, clock, leaseUntil });
  budget.bindIdentities = true;
  budget.deadline = Math.min(budget.deadline, started + (limits.maxMs ?? 90000));
  const result = { copied: 0, reverified: 0, processed: 0, retriesAttempted: 0, complete: false, mode };
  const total = Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM diary_photos').first()).count) * 3;
  let remaining = maxScanItems, stopped = false;
  const cache = new Map();
  const retryKey = (id, variant) => id + '/' + variant;
  const isVerified = item => ['verified','verification_pending'].includes(item.state);
  const count = (item, direction = 1) => {
    if (isVerified(item)) {
      state.counts.backedUp += direction; state.counts.bytes += direction * item.bytes;
      if (item.state === 'verification_pending') state.counts.verificationPending += direction;
    } else state.counts[item.state] += direction;
  };
  const execute = async (row, i) => {
    const [variant,column] = VARIANTS[i], id = retryKey(row.id, variant);
    if (cache.has(id)) return cache.get(id);
    if (!remaining || clock() >= budget.deadline) return { state: 'deferred' };
    let item = await processPhoto(env, row, variant, column, budget);
    if (item.state === 'deferred') return item;
    if (isVerified(item)) {
      try {
        if (clock() >= leaseUntil) throw new Error('ConcurrentWrite');
        await bindPhotoIdentity(env.DB, row, item);
      } catch { item = { ...item, state: 'failed', retryable: true }; }
    }
    const retryable = item.state === 'missing' || (item.state === 'failed' && item.retryable);
    const ticket = state.retries.find(t=>retryKey(t.id,t.variant)===id);
    // Never silently drop priority work on a broad outage. Keep the normal
    // cursor at this object until the bounded retry journal has room again.
    if (retryable && !ticket && state.retries.length >= MAX_RETRIES) return { state: 'deferred' };
    if (ticket?.countedCycle === state.cycleId) {
      count({ state: ticket.countedState }, -1);
      count(item);
    }
    if (retryable) {
      const next = ticket || { id: row.id, variant, attempts: 0 };
      next.attempts++; next.nextAttemptAt = now + Math.min(6*3600000, 60000 * 2 ** Math.min(next.attempts-1,9));
      if (ticket?.countedCycle === state.cycleId) next.countedState = item.state;
      if (!ticket) state.retries.push(next);
    } else if (ticket) state.retries = state.retries.filter(t=>t!==ticket);
    remaining--; result.processed++; if (item.copied) result.copied++; if (item.reverified) result.reverified++;
    cache.set(id, item);
    return item;
  };
  const process = async (row, first, counted) => {
    for (let i = first; i < VARIANTS.length; i++) {
      if (!remaining || clock() >= budget.deadline) { stopped = true; return i; }
      const item = await execute(row, i);
      if (item.state === 'deferred') { stopped = true; return i; }
      if (counted) {
        state.counts.scanned++;
        count(item);
        const ticket = state.retries.find(t=>t.id===row.id&&t.variant===VARIANTS[i][0]);
        if (ticket) { ticket.countedCycle = state.cycleId; ticket.countedState = item.state; }
      }
    }
    return 3;
  };
  for (const ticket of [...state.retries].filter(t=>t.nextAttemptAt<=now).sort((a,b)=>a.nextAttemptAt-b.nextAttemptAt).slice(0,RETRIES_PER_BATCH)) {
    const row = await env.DB.prepare(`SELECT ${columns} FROM diary_photos WHERE id = ? LIMIT 1`).bind(ticket.id).first();
    if (!row) { state.retries = state.retries.filter(t=>t!==ticket); continue; }
    result.retriesAttempted++;
    const item = await execute(row, VARIANTS.findIndex(([v])=>v===ticket.variant));
    if (item.state === 'deferred') break;
  }
  // New arrivals have their own high-water mark. They are serviced before the
  // historical cursor, even when a backlog or revalidation cycle spans days.
  if (mode === 'copy') {
    if (!state.head) {
      // On migration, give recent uploads priority over the old inventory too.
      state.head = { at: new Date(now - 86400000).toISOString().slice(0,10), id: '', variant: 0 };
    }
    const h = state.head;
    const fresh = await env.DB.prepare(`SELECT ${columns} FROM diary_photos WHERE created_at > ? OR (created_at = ? AND id >= ?) ORDER BY created_at,id LIMIT 41`).bind(h.at,h.at,h.id).all();
    for (const row of fresh.results) {
      const first = row.created_at === state.head.at && row.id === state.head.id ? state.head.variant : 0;
      const next = await process(row, first, false);
      state.head = { at: row.created_at, id: row.id, variant: next };
      if (stopped) break;
    }
  }
  let finished = false;
  while (!stopped && remaining) {
    const cursor = state.cursor || { id: '', variant: 0 };
    const page = await env.DB.prepare(`SELECT ${columns} FROM diary_photos WHERE id >= ? ORDER BY id LIMIT 41`).bind(cursor.id).all();
    if (!page.results.length) { finished = true; break; }
    for (const row of page.results) {
      const next = await process(row, row.id === cursor.id ? cursor.variant : 0, true);
      state.cursor = { id: row.id, variant: next };
      if (stopped || !remaining) break;
    }
    if (!stopped && page.results.length < 41 && state.cursor.id === page.results.at(-1).id && state.cursor.variant === 3) { finished = true; break; }
  }
  const counts = state.counts;
  const countsComplete = finished && counts.scanned === total;
  result.complete = countsComplete && !counts.pending && !counts.failed && !counts.corrupt && !counts.oversized && !counts.missing && !state.retries.length;
  if (result.complete && mode === 'copy') { state.lastFullCopyAt = new Date(now).toISOString(); state.initialCatchupComplete = true; }
  state.summary = { ...counts, total, unknown: Math.max(0,total - counts.scanned), countsComplete,
    lastRunAt: new Date(now).toISOString(), lastFullCopyAt: state.lastFullCopyAt || null, copied: result.copied, reverified: result.reverified,
    complete: result.complete, mode, retryPending: state.retries.length, retriesAttempted: result.retriesAttempted, cycleStartedAt: state.cycleStartedAt };
  if (finished) state.cursor = null;
  if (clock() >= leaseUntil) throw new Error('ConcurrentWrite');
  const metadata = Object.fromEntries(Object.entries(state.summary).filter(([,v])=>v != null).map(([k,v])=>[k,String(v)]));
  await verifiedPut(bucket, key, await compress(state), { format: state.format, ...metadata }, saved ? { etagMatches: saved.etag } : { etagDoesNotMatch: '*' });
  return { ...result, ...state.summary, estimatedIoBytes: budget.bytes };
}

export async function runScheduledPhotoBackup(env, now = Date.now(), options = {}) {
  const runId = crypto.randomUUID();
  const stage = options.mode === 'verify' ? 'photo_verification' : options.catchup ? 'photo_catchup' : 'photos';
  const audit = (state, details = {}) => reportRun(env, 'diary', runId, state, { kind: options.mode === 'verify' ? 'photo-verification' : 'photos', stage, ...details });
  try {
    const result = await runPhotoBatch(env, { ...options, now, onStart: async () => {
      if (!await audit('started')) throw new Error('AuditUnavailable');
    } });
    if (result.skipped) {
      // No-op invocations do not replace the last real copy outcome.
      return result;
    }
    if (!await audit(result.complete ? 'succeeded' : 'partial', { pending: result.pending + result.unknown, bytes: result.estimatedIoBytes,
      reason: result.corrupt || result.failed || result.missing ? 'verification_failed' : result.oversized ? 'object_too_large' : 'backlog' })) throw new Error('AuditUnavailable');
    return result;
  } catch {
    await audit('failed', { reason: 'operation_failed' });
    throw new Error('PhotoBackupRunFailed'); // fixed text, never source data
  }
}
