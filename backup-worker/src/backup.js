import { SERVICES } from './registry.js';
import { reportRun } from './monitor.js';

export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function compress(value) {
  return new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
export async function decode(bytes) {
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
export const objectBytes = object => new Response(object.body).arrayBuffer();
export async function verifiedPut(bucket, key, bytes, customMetadata = {}, onlyIf = undefined) {
  const sha256 = await digest(bytes);
  const stored = await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' }, customMetadata: { ...customMetadata, sha256 }, ...(onlyIf ? { onlyIf } : {}) });
  if (stored === null) throw new Error('ConcurrentWrite');
  const copy = await bucket.get(key);
  if (!copy || await digest(await objectBytes(copy)) !== sha256) throw new Error('VerificationFailed');
  return sha256;
}

export async function capture(db, service, now = Date.now()) {
  const spec = SERVICES[service];
  if (!spec || !db) throw new Error('SourceUnavailable');
  // D1 batch runs the allowlisted SELECTs in one transaction. No cross-DB atomicity is claimed.
  const result = await db.batch([
    ...spec.tables.map(t => db.prepare(`SELECT ${t.columns.join(',')} FROM ${t.name}`)),
    ...spec.tables.map(t => db.prepare(`SELECT name FROM pragma_table_info('${t.name}') ORDER BY cid`)),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name")
  ]);
  const tables = {};
  for (let i = 0; i < spec.tables.length; i++) {
    if (result[i]?.success === false || !Array.isArray(result[i]?.results)) throw new Error('CaptureFailed');
    const t = spec.tables[i];
    if (result[spec.tables.length + i]?.results?.map(c => c.name).join(',') !== t.sourceColumns) throw new Error('SchemaReviewRequired');
    tables[t.name] = { columns: t.columns, rows: result[i].results, rowCount: result[i].results.length };
  }
  if (result.at(-1).results.some(r => r.type === 'table' && !spec.knownTables.includes(r.name) && r.name !== 'd1_migrations'
    && !['password_auth_policy', 'password_auth_policy_audit'].includes(r.name))) throw new Error('SchemaReviewRequired');
  return { formatVersion: 1, service, database: spec.database, expectedMigration: spec.migration,
    createdAt: new Date(now).toISOString(), schema: result.at(-1).results, tables };
}

export async function prune(bucket, prefix, retention) {
  const list = await listObjects(bucket, prefix);
  const keys = list.map(o => o.key).filter(k => {
    const suffix = k.slice(prefix.length);
    if (prefix.endsWith('/monthly/')) return /^\d{4}-(0[1-9]|1[0-2])\.json\.gz$/.test(suffix);
    if (!/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(suffix)) return false;
    const date = new Date(suffix.slice(0, 10) + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === suffix.slice(0, 10);
  }).sort().reverse();
  const obsolete = keys.slice(retention);
  if (obsolete.length) await bucket.delete(obsolete);
  return obsolete.length;
}
export async function listObjects(bucket, prefix) {
  const objects = []; let cursor;
  do {
    const page = await bucket.list({ prefix, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error('IncompleteListing');
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return objects;
}

export async function backupService(env, service, now = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const runId = crypto.randomUUID();
  if (!await reportRun(env, service, runId, 'started', {}, now)) return { state: 'audit_unavailable' };
  const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const base = `d1/${service}/`;
  let bytes, sha256, stage = 'capture', attempt, reason = 'operation_failed';
  for (attempt = 1; attempt <= 3; attempt++) {
    try {
      stage = 'capture';
      bytes = await compress(await capture(env[SERVICES[service].binding], service, now));
      stage = 'daily_save';
      // Never overwrite a known-good daily generation on retry or duplicate cron delivery.
      const daily = `${base}daily/${day}.json.gz`;
      const prior = await env.BACKUP.get(daily);
      if (prior) {
        const previous = new Uint8Array(await objectBytes(prior));
        if (!prior.customMetadata?.sha256 || await digest(previous) !== prior.customMetadata.sha256) throw new Error('ExistingGenerationInvalid');
        bytes = previous;
      }
      sha256 = await verifiedPut(env.BACKUP, `${base}attempts/${runId}.json.gz`, bytes, { service, format: 'troom-d1-v1' });
      if (!prior) await verifiedPut(env.BACKUP, daily, bytes, { service, format: 'troom-d1-v1' }, { etagDoesNotMatch: '*' });
      stage = 'monthly_save';
      const monthly = `${base}monthly/${day.slice(0, 7)}.json.gz`;
      const month = await env.BACKUP.get(monthly);
      if (!month) await verifiedPut(env.BACKUP, monthly, bytes, { service, format: 'troom-d1-v1' }, { etagDoesNotMatch: '*' });
      else if (!month.customMetadata?.sha256 || await digest(await objectBytes(month)) !== month.customMetadata.sha256) throw new Error('ExistingGenerationInvalid');
      await env.BACKUP.delete(`${base}attempts/${runId}.json.gz`);
      break;
    } catch (error) {
      reason = ({ SchemaReviewRequired: 'schema_review_required', SourceUnavailable: 'source_unavailable',
        VerificationFailed: 'verification_failed', ExistingGenerationInvalid: 'verification_failed', ConcurrentWrite: 'concurrent_write' })[error?.message] || 'operation_failed';
      if (attempt < 3) await sleep(attempt * 1000);
    }
  }
  if (attempt > 3) {
    try { await env.BACKUP?.delete(`${base}attempts/${runId}.json.gz`); } catch {}
    await reportRun(env, service, runId, 'failed', { stage, reason, attempt: 3 });
    return { state: 'failed' };
  }
  const recorded = await reportRun(env, service, runId, 'succeeded', { bytes: bytes.length, attempt });
  if (!recorded) return { state: 'audit_unavailable' }; // Keep older recoverable generations.
  try {
    await prune(env.BACKUP, `${base}daily/`, 30);
    await prune(env.BACKUP, `${base}monthly/`, 12);
    const oldCandidates = (await listObjects(env.BACKUP, `${base}attempts/`)).filter(o =>
      /^[0-9a-f-]{36}\.json\.gz$/.test(o.key.split('/').at(-1)) && o.uploaded.getTime() < now - 86400000).map(o => o.key);
    if (oldCandidates.length) await env.BACKUP.delete(oldCandidates);
  } catch {
    await reportRun(env, service, runId, 'prune_failed', { stage: 'retention', reason: 'retention_failed' });
    return { state: 'prune_failed' };
  }
  return { state: 'ok', sha256 };
}
