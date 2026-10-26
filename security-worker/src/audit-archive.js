import { compress, verifiedPut, listObjects, digest } from '../../backup-worker/src/backup.js';
import { snapshotStatement, snapshotTables } from '../../backup-worker/src/snapshot.js';
import { hashObject, withBackupLock } from '../../backup-worker/src/integrity.js';
import { SERVICES } from '../../backup-worker/src/registry.js';
import { reportRun } from '../../backup-worker/src/monitor.js';

const audit = SERVICES.security.tables.find(t => t.name === 'security_audit_events');
export async function pendingArchive(env, cutoff) {
  // Indexed bounded probe: never COUNT(*) the entire retained history.
  const r = await env.DB.prepare('SELECT occurred_at FROM security_audit_events WHERE occurred_at < ? ORDER BY occurred_at, event_id LIMIT 1001').bind(cutoff).all();
  const rows = r.results || [];
  return { pendingCount: rows.length, pendingCapped: rows.length === 1001, oldestPendingAt: rows[0]?.occurred_at || null };
}
export async function archiveIfPending(env, cutoff, now = Date.now()) {
  try { if (!(await pendingArchive(env, cutoff)).pendingCount) return true; }
  catch { return archiveAuditEvents(env, cutoff, now, { maxPages: 5 }); }
  return archiveAuditEvents(env, cutoff, now, { maxPages: 5 });
}
export async function archiveAuditEvents(env, cutoff, now = Date.now(), { maxPages = 10 } = {}) {
  try { return await withBackupLock(() => archiveUnlocked(env,cutoff,now,maxPages)); }
  catch {
    await reportRun({SECURITY:{recordAuditEvent:env.recordArchiveAudit},SECURITY_AUDIT:env.SECURITY_AUDIT},'security-audit',crypto.randomUUID(),'failed',{stage:'archive',reason:'concurrent_write'});
    return false;
  }
}
async function archiveUnlocked(env,cutoff,now,maxPages) {
  const runId = crypto.randomUUID();
  const monitor = { SECURITY: { recordAuditEvent: env.recordArchiveAudit }, SECURITY_AUDIT: env.SECURITY_AUDIT };
  if (!env.recordArchiveAudit || !await reportRun(monitor, 'security-audit', runId, 'started', {}, now)) return false;
  let deleted = 0, backlog;
  try {
    if (!env.AUDIT_ARCHIVE) throw new Error('ArchiveUnavailable');
    const schema = await env.DB.prepare("SELECT name FROM pragma_table_info('security_audit_events') ORDER BY cid").all();
    if (schema.results.map(c => c.name).join(',') !== audit.sourceColumns) throw new Error('SchemaReviewRequired');
    for (let page = 0; page < Math.min(10, maxPages); page++) {
      const table = { name: 'audit', columns: [...audit.columns, 'identity_display_name'],
        source: '(SELECT a.*, (SELECT display_name FROM security_identities WHERE id=a.identity_id) AS identity_display_name FROM security_audit_events a WHERE occurred_at < ?1 ORDER BY occurred_at,event_id LIMIT 100)' };
      const result = await env.DB.batch([snapshotStatement(env.DB, [table], { rows: 100, params: [cutoff] })]);
      const rows = snapshotTables(result[0]).audit.rows;
      if (!rows.length) break;
      // Stable payload/key makes retries of the same row versions idempotent.
      const bytes = await compress({ formatVersion: 1, type: 'security-audit', rows });
      const sha = await digest(bytes), month = rows[0].occurred_at.slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('InvalidDate');
      const object = 'security-audit/' + month + '/' + sha + '.json.gz';
      await verifiedPut(env.AUDIT_ARCHIVE, object, bytes, { format: 'troom-audit-v1', rowCount: String(rows.length), firstAt: rows[0].occurred_at, lastAt: rows.at(-1).occurred_at }, { etagDoesNotMatch: '*' }).catch(async error => {
        if (error.message !== 'ConcurrentWrite') throw error;
        const prior = await env.AUDIT_ARCHIVE.get(object);
        if (!prior || await hashObject(prior) !== sha) throw new Error('VerificationFailed');
      });
      const summaryPath = '_metadata/security-audit/' + month + '.json.gz';
      const priorSummary = await env.AUDIT_ARCHIVE.head(summaryPath);
      const packs = await listObjects(env.AUDIT_ARCHIVE, 'security-audit/' + month + '/');
      const summary = { month, bytes: packs.reduce((n,p) => n+p.size,0), objectCount: packs.length,
        rowCount: packs.reduce((n,p) => n+Number(p.customMetadata?.rowCount||0),0),
        firstAt: packs.map(p=>p.customMetadata?.firstAt).filter(Boolean).sort()[0], lastAt: packs.map(p=>p.customMetadata?.lastAt).filter(Boolean).sort().at(-1) };
      await verifiedPut(env.AUDIT_ARCHIVE, summaryPath, await compress(summary), Object.fromEntries(Object.entries(summary).map(([k,v])=>[k,String(v)])), priorSummary ? { etagMatches: priorSummary.etag } : { etagDoesNotMatch: '*' });
      // <=100 bindings per statement, and one guarded deletion per complete row version.
      const statements = [], perStatement = Math.floor(100 / audit.columns.length);
      for (let i=0;i<rows.length;i+=perStatement) {
        const group=rows.slice(i,i+perStatement);
        statements.push(env.DB.prepare('DELETE FROM security_audit_events WHERE '+group.map(()=> '('+audit.columns.map(c=>c+' IS ?').join(' AND ')+')').join(' OR ')+' RETURNING event_id')
          .bind(...group.flatMap(row=>audit.columns.map(c=>row[c]))));
      }
      const results = await env.DB.batch(statements);
      if (results.some(r=>r.success===false)) throw new Error('PruneFailed');
      deleted += results.reduce((n,r)=>n+(r.results?.length||0),0);
    }
    backlog = await pendingArchive(env, cutoff);
    const recorded = await reportRun(monitor, 'security-audit', runId, backlog.pendingCount ? 'partial' : 'succeeded',
      { deleted, ...backlog, ...(backlog.pendingCount ? { stage: 'catchup', reason: 'backlog' } : {}) });
    return recorded && !backlog.pendingCount;
  } catch (error) {
    try { backlog=await pendingArchive(env,cutoff); } catch {}
    await reportRun(monitor, 'security-audit', runId, 'failed', { stage:'archive', reason:error.message==='SchemaReviewRequired'?'schema_review_required':'archive_failed', deleted, ...backlog });
    return false;
  }
}
