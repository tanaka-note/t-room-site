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
    // Sequential bounded work avoids a burst of simultaneous D1 scans.
    for (const id of Object.keys(SERVICES)) {
      try { await backupService(env, id, now); }
      catch { console.error(JSON.stringify({ event: 'backup_unexpected_failure', service: id })); }
    }
  }
};
