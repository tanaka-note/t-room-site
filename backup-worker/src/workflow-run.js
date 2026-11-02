import { saveExport, pruneExports, exportBucket, DATABASES } from './export-backup.js';
import { reportRun } from './monitor.js';
import { withExportLease } from './export-lease.js';

const REASONS = { SchemaReviewRequired: 'schema_review_required', ExportUnavailable: 'export_unavailable', ExportTimeout: 'export_timeout',
    ExportInvalid: 'export_invalid', SnapshotInvalid: 'verification_failed', VerificationFailed: 'verification_failed',
    SourceUnavailable: 'source_unavailable', SnapshotTooLarge: 'snapshot_too_large', UnsafeInteger: 'unsafe_integer',
    ConcurrentWrite: 'concurrent_write', AuditUnavailable: 'audit_unavailable' };
export function exportReason(error) {
  return Object.hasOwn(REASONS,error?.message) ? REASONS[error.message] : 'operation_failed';
}

export async function executeExportWorkflow(env, payload, step) {
  const { service, scheduledTime } = payload || {};
  if (!Object.hasOwn(DATABASES, service) || !Number.isSafeInteger(scheduledTime) || scheduledTime <= 0) throw new Error('InvalidBackupJob');
  // Avoid starting all database exports at once. Each job has durable retries
  // and an independent outcome; no SQL/body/URL is returned to Workflow state.
  const offset = Object.keys(DATABASES).indexOf(service) * 30;
  if (offset) await step.sleep('stagger-exports', `${offset} seconds`);
  const runId = await step.do('run-id', () => crypto.randomUUID());
  await step.do('started', async () => {
    if (!await reportRun(env, service, runId, 'started', {}, scheduledTime)) throw new Error('AuditUnavailable');
    return true;
  });
  try {
    await step.do('export-project-save-verify-retain', { retries: { limit: 2, delay: '5 minutes', backoff: 'exponential' }, timeout: '15 minutes' }, async () => {
      try {
        return await withExportLease(exportBucket(env, service), service, async guard => {
          const saved = await saveExport(env, service, scheduledTime, { guard });
          if (!await reportRun(env, service, runId, 'succeeded', { bytes: saved.bytes, rowCount: saved.rowCount })) throw new Error('AuditUnavailable');
          try { await pruneExports(exportBucket(env, service), service, guard); }
          catch { throw new Error('RetentionFailed'); }
          return { bytes: saved.bytes, rowCount: saved.rowCount };
        });
      } catch (error) {
        // Errors are persisted by Workflows too. Sanitize BEFORE the step throws.
        const safe = error.message === 'RetentionFailed' ? 'retention_failed' : exportReason(error);
        throw new Error(safe);
      }
    });
  } catch (error) {
    // Workflow errors can wrap the cause. Record only a fixed code, never the
    // provider's exception text or the SQL dump/download credentials.
    const safe = error.message === 'retention_failed' ? 'retention_failed' : Object.values(REASONS).includes(error.message) ? error.message : 'operation_failed';
    await step.do('failed', () => reportRun(env, service, runId, safe === 'retention_failed' ? 'prune_failed' : 'failed', { stage: safe === 'retention_failed' ? 'retention' : 'export', reason: safe }));
    throw new Error('D1BackupFailed');
  }
  return { service, state: 'ok' };
}
