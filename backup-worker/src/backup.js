import { SERVICES } from './registry.js';
import { assertSchema } from './schema-guard.js';
import { reportRun } from './monitor.js';

import { snapshotStatement, snapshotTables } from './snapshot.js';
import { compress, decode, digest, publishGeneration, verifiedGeneration, withBackupLock } from './integrity.js';
export { compress, decode, digest, verifiedPut, objectBytes } from './integrity.js';
export async function capture(db, service, now = Date.now()) {
  const spec = SERVICES[service];
  if (!spec || !db) throw new Error('SourceUnavailable');
  const startedAt = new Date().toISOString();
  const result = await db.batch([
    snapshotStatement(db, spec.tables),
    ...spec.tables.map(t => db.prepare(`SELECT name FROM pragma_table_info('${t.name}') ORDER BY cid`)),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name")
  ]);
  const tables = snapshotTables(result[0]);
  for (let i = 0; i < spec.tables.length; i++) {
    const t = spec.tables[i];
    if (result[i + 1]?.results?.map(c => c.name).join(',') !== t.sourceColumns) throw new Error('SchemaReviewRequired');
  }
  if (result.at(-1).results.some(r => r.type === 'table' && !spec.knownTables.includes(r.name) && r.name !== 'd1_migrations'
    && !['password_auth_policy', 'password_auth_policy_audit'].includes(r.name))) throw new Error('SchemaReviewRequired');
  await assertSchema(service,result.at(-1).results);
  return { formatVersion: 2, service, database: spec.database, expectedMigration: spec.migration,
    createdAt: startedAt, completedAt: new Date().toISOString(), scheduledFor: new Date(now).toISOString(), consistency: 'single-database-transaction', schema: result.at(-1).results, tables };
}

export async function prune(bucket, prefix, retention, validate) {
  const list = await listObjects(bucket, prefix);
  const keys = list.map(o => o.key).filter(k => {
    const suffix = k.slice(prefix.length);
    if (prefix.endsWith('/monthly/')) return /^\d{4}-(0[1-9]|1[0-2])\.json\.gz$/.test(suffix);
    if (!/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(suffix)) return false;
    const date = new Date(suffix.slice(0, 10) + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === suffix.slice(0, 10);
  }).sort().reverse();
  // Validate every retained recovery point before deleting any older object.
  if (validate) for (const key of keys.slice(0, retention)) {
    if (!await verifiedGeneration(bucket, key, validate)) throw new Error('VerificationFailed');
  }
  const obsolete = keys.slice(retention);
  for (let i = 0; i < obsolete.length; i += 1000) await bucket.delete(obsolete.slice(i, i + 1000));
  return obsolete.length;
}
export async function listObjects(bucket, prefix) {
  const objects = []; let cursor;
  do {
    const page = await bucket.list({ prefix, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    if (objects.length > 20000) throw new Error('SnapshotTooLarge');
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error('IncompleteListing');
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return objects;
}

export async function backupService(env, service, now = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms))) {
  try { return await withBackupLock(() => backupServiceUnlocked(env, service, now, sleep)); }
  catch (error) {
    await reportRun(env,service,crypto.randomUUID(),'failed',{stage:'capture',reason:error.message==='ConcurrentWrite'?'concurrent_write':'operation_failed'});
    return {state:'failed'};
  }
}
async function backupServiceUnlocked(env, service, now, sleep) {
  const runId = crypto.randomUUID();
  if (!await reportRun(env, service, runId, 'started', {}, now)) return { state: 'audit_unavailable' };
  const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const base = `d1/${service}/`;
  let bytes, sha256, savedAll = false, stage = 'capture', attempt, reason = 'operation_failed';
  for (attempt = 1; attempt <= 3; attempt++) {
    try {
      stage = 'capture';
      bytes = await compress(await capture(env[SERVICES[service].binding], service, now));
      stage = 'daily_save';
      const daily = `${base}v2/daily/${day}.json.gz`;
      const saved = await publishGeneration(env.BACKUP, daily, bytes, { service, format: 'troom-d1-v2' }, p => validateSnapshot(p, service));
      bytes = saved.bytes; sha256 = saved.sha256;
      stage = 'monthly_save';
      await publishGeneration(env.BACKUP, `${base}v2/monthly/${day.slice(0, 7)}.json.gz`, bytes, { service, format: 'troom-d1-v2' }, p => validateSnapshot(p, service));
      savedAll = true;
      break;
    } catch (error) {
      reason = ({ SchemaReviewRequired: 'schema_review_required', SourceUnavailable: 'source_unavailable',
        VerificationFailed: 'verification_failed', SnapshotInvalid: 'verification_failed', ExistingGenerationInvalid: 'verification_failed', ConcurrentWrite: 'concurrent_write', SnapshotTooLarge: 'snapshot_too_large', UnsafeInteger: 'unsafe_integer', LegacyGenerationUnverified: 'legacy_unverified' })[error?.message] || 'operation_failed';
      if (['SchemaReviewRequired','SnapshotTooLarge','UnsafeInteger','LegacyGenerationUnverified'].includes(error?.message)) break;
      if (attempt < 3) await sleep(attempt * 1000);
    }
  }
  if (!savedAll) {
    await reportRun(env, service, runId, 'failed', { stage, reason, attempt: Math.min(attempt, 3) });
    return { state: 'failed' };
  }
  const recorded = await reportRun(env, service, runId, 'succeeded', { bytes: bytes.length, attempt });
  if (!recorded) return { state: 'audit_unavailable' }; // Keep older recoverable generations.
  try {
    await prune(env.BACKUP, `${base}v2/daily/`, 30, p => validateSnapshot(p, service));
    await prune(env.BACKUP, `${base}v2/monthly/`, 12, p => validateSnapshot(p, service));
  } catch {
    await reportRun(env, service, runId, 'prune_failed', { stage: 'retention', reason: 'retention_failed' });
    return { state: 'prune_failed' };
  }
  return { state: 'ok', sha256 };
}

export function validateSnapshot(p, service) {
  const spec = SERVICES[service];
  if (!p || ![1,2].includes(p.formatVersion) || p.service !== service || p.database !== spec.database || !Array.isArray(p.schema)) throw new Error('SnapshotInvalid');
  if (Object.keys(p.tables || {}).sort().join(',') !== spec.tables.map(t => t.name).sort().join(',')) throw new Error('SnapshotInvalid');
  for (const t of spec.tables) {
    const table = p.tables[t.name];
    if (JSON.stringify(table.columns) !== JSON.stringify(t.columns) || !Array.isArray(table.rows) || table.rowCount !== table.rows.length) throw new Error('SnapshotInvalid');
    if (table.rows.some(r => !r || Object.keys(r).sort().join(',') !== [...t.columns].sort().join(','))) throw new Error('SnapshotInvalid');
  }
}
