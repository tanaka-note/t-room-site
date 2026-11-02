import { SERVICES } from './registry.js';

export async function dispatchBackup(env, service, scheduledTime) {
  if (!(service === 'diary' || Object.hasOwn(SERVICES, service)) || !Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || !env.D1_BACKUPS) throw new Error('BackupDispatchFailed');
  const id = `${service}-${scheduledTime}`;
  try { await env.D1_BACKUPS.create({ id, params: { service, scheduledTime } }); }
  catch {
    // A create response may have been lost after the instance was committed.
    // Accept only an existing nonfailed instance with this deterministic ID.
    try {
      const instance = await env.D1_BACKUPS.get(id);
      const { status } = await instance.status();
      if (!['queued','running','waiting','paused','complete'].includes(status)) throw new Error();
    } catch { throw new Error('BackupDispatchFailed'); }
  }
  return { scheduled: true, instanceId: id };
}

export async function dispatchServices(env, scheduledTime) {
  let failed = 0;
  for (const service of Object.keys(SERVICES)) {
    try { await dispatchBackup(env, service, scheduledTime); }
    catch { failed++; console.error(JSON.stringify({ event: 'backup_dispatch_failed', service, scheduledTime })); }
  }
  if (failed) throw new Error('BackupDispatchFailed');
  console.log(JSON.stringify({ event: 'backup_dispatched', scheduledTime, total: Object.keys(SERVICES).length }));
}
