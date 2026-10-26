import { WorkerEntrypoint } from 'cloudflare:workers';
import { SERVICES } from './registry.js';
import { backupService } from './backup.js';
import { getBackupSnapshot } from './browser.js';

export class BackupBrowserIntegration extends WorkerEntrypoint {
  async getSnapshot(options) { return getBackupSnapshot(this.env, options); }
}
export default {
  fetch() { return new Response('Not found', { status: 404 }); },
  async scheduled(controller, env) {
    const now = Number(controller?.scheduledTime) || Date.now();
    const runId = crypto.randomUUID();
    const knownStates = new Set(['ok', 'failed', 'audit_unavailable', 'prune_failed']);
    const results = [];
    // Complete every service before rejecting the invocation. Returned business
    // failures must reach the Cron outcome just like unexpected exceptions.
    for (const id of Object.keys(SERVICES)) {
      let state;
      try {
        const value = (await backupService(env, id, now))?.state;
        state = knownStates.has(value) ? value : 'invalid_result';
      } catch {
        state = 'unexpected_failure';
        console.error(JSON.stringify({ event: 'backup_unexpected_failure', runId, service: id }));
      }
      // Never log returned objects, exception messages, or backup contents.
      results.push({ service: id, state });
    }
    const counts = { ok: 0, failed: 0, audit_unavailable: 0, prune_failed: 0, unexpected_failure: 0, invalid_result: 0 };
    for (const result of results) counts[result.state]++;
    const complete = counts.ok === results.length;
    const summary = { event: 'backup_run_finished', runId, scheduledTime: now,
      state: complete ? 'ok' : 'failed', total: results.length, counts, services: results };
    if (!complete) {
      console.error(JSON.stringify(summary));
      const error = new Error('Backup run incomplete');
      error.name = 'BackupRunError';
      throw error;
    }
    console.log(JSON.stringify(summary));
  }
};
