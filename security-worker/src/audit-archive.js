import { compress, verifiedPut, listObjects } from '../../backup-worker/src/backup.js';
import { reportRun } from '../../backup-worker/src/monitor.js';

// Never expire audit records merely because they are old. Archive first, read
// back and verify, then delete only the exact unchanged rows that were saved.
export async function archiveAuditEvents(env, cutoff, now = Date.now()) {
  const runId = crypto.randomUUID();
  const monitor = { SECURITY: { recordAuditEvent: env.recordArchiveAudit }, SECURITY_AUDIT: env.SECURITY_AUDIT };
  if (!env.recordArchiveAudit || !await reportRun(monitor, 'security-audit', runId, 'started', {}, now)) return false;
  let deleted = 0;
  try {
    if (!env.AUDIT_ARCHIVE) throw new Error('ArchiveUnavailable');
    // Bounded catch-up. Excess old rows remain in D1 for subsequent schedules.
    for (let page = 0; page < 5; page++) {
      const result = await env.DB.prepare(`SELECT a.*,
        (SELECT display_name FROM security_identities WHERE id = a.identity_id) AS identity_display_name
        FROM security_audit_events a WHERE occurred_at < ? ORDER BY occurred_at, event_id LIMIT 100`).bind(cutoff).all();
      const rows = result.results || [];
      if (!rows.length) break;
      const bytes = await compress({ formatVersion: 1, type: 'security-audit', archivedAt: new Date(now).toISOString(), rows });
      const month = new Date(now).toISOString().slice(0, 7);
      const object = `security-audit/${month}/${runId}-${page}.json.gz`;
      await verifiedPut(env.AUDIT_ARCHIVE, object, bytes, { format: 'troom-audit-v1', rowCount: String(rows.length), firstAt: rows[0].occurred_at, lastAt: rows.at(-1).occurred_at });
      const summaryPath = `_metadata/security-audit/${month}.json.gz`;
      const priorSummary = await env.AUDIT_ARCHIVE.head(summaryPath);
      const packs = await listObjects(env.AUDIT_ARCHIVE, `security-audit/${month}/`);
      const summary = { month, bytes: packs.reduce((n, p) => n + p.size, 0), objectCount: packs.length,
        rowCount: packs.reduce((n, p) => n + Number(p.customMetadata?.rowCount || 0), 0),
        firstAt: packs.map(p => p.customMetadata?.firstAt).filter(Boolean).sort()[0],
        lastAt: packs.map(p => p.customMetadata?.lastAt).filter(Boolean).sort().at(-1) };
      await verifiedPut(env.AUDIT_ARCHIVE, summaryPath, await compress(summary),
        Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, String(v)])),
        priorSummary ? { etagMatches: priorSummary.etag } : { etagDoesNotMatch: '*' });
      const statements = rows.map(row => {
        const columns = Object.keys(row).filter(c => c !== 'identity_display_name');
        if (columns.some(c => !/^[a-z_]+$/.test(c))) throw new Error('UnexpectedSchema');
        return env.DB.prepare(`DELETE FROM security_audit_events WHERE ${columns.map(c => `${c} IS ?`).join(' AND ')}`)
          .bind(...columns.map(c => row[c]));
      });
      const results = await env.DB.batch(statements);
      if (results.some(r => r.success === false)) throw new Error('PruneFailed');
      deleted += results.reduce((n, r) => n + (Number(r.meta?.changes || 0) > 0 ? 1 : 0), 0);
    }
    const remaining = await env.DB.prepare('SELECT 1 AS pending FROM security_audit_events WHERE occurred_at < ? LIMIT 1').bind(cutoff).first();
    // A capped catch-up is explicitly partial; do not present it as fully archived.
    return await reportRun(monitor, 'security-audit', runId, remaining ? 'partial' : 'succeeded',
      { deleted, remaining: Boolean(remaining), ...(remaining ? { stage: 'catchup', reason: 'backlog' } : {}) });
  } catch {
    await reportRun(monitor, 'security-audit', runId, 'failed', { stage: 'archive', reason: 'archive_failed', deleted });
    return false;
  }
}
