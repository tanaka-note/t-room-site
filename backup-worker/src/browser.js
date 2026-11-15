import { SERVICES } from './registry.js';
import { listObjects } from './backup.js';
import { runState } from './monitor.js';

const CACHE_KEY = 'https://backups.internal/storage-v3';
export async function serviceStatus(env, service) {
  const result = await env.SECURITY_DB.prepare(`SELECT event_id, occurred_at, event_type, details_json
    FROM security_audit_events WHERE target_type = 'backup' AND target_id = ?
    AND event_type IN ('backup_started','backup_succeeded','backup_failed','backup_partial','backup_prune_failed')
    ORDER BY occurred_at DESC, event_id DESC LIMIT 40`).bind(service).all();
  return runState(result.results || [], { minute: service === 'security-audit' ? 41 : 40 });
}
function metadata(o) {
  return { name: o.key.split('/').at(-1), sizeBytes: o.size + Number(o.customMetadata?.dataBytes || 0), updatedAt: o.uploaded.toISOString(), sha256: o.customMetadata?.sha256 || null };
}
async function dataBytes(bucket, prefix) {
  let cursor, total = 0;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    total += page.objects.reduce((n,o) => n+o.size,0);
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error('IncompleteListing');
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return total;
}
export async function storageSnapshot(env, refresh = false, cache = globalThis.caches?.default) {
  const cached = await cache?.match(CACHE_KEY).catch(() => null);
  if (cached) {
    const value = await cached.json();
    // A cached snapshot from before a registry addition must not hide the service.
    const expected=[...Object.keys(SERVICES),'security-audit'].sort().join(',');
    if (Array.isArray(value.services) && value.services.map(s=>s.id).sort().join(',')===expected
      && (!refresh || Date.now() - Date.parse(value.observedAt) < 60000)) return value;
  }
  const services = [];
  for (const [id, spec] of Object.entries(SERVICES)) {
    try {
      const [v3Daily, v3Monthly, v2Daily, v2Monthly, legacyDaily, legacyMonthly, storedDataBytes] = await Promise.all([
        listObjects(env.BACKUP, `d1/${id}/v3/daily/`), listObjects(env.BACKUP, `d1/${id}/v3/monthly/`),
        listObjects(env.BACKUP, `d1/${id}/v2/daily/`), listObjects(env.BACKUP, `d1/${id}/v2/monthly/`),
        listObjects(env.BACKUP, `d1/${id}/daily/`), listObjects(env.BACKUP, `d1/${id}/monthly/`), dataBytes(env.BACKUP, `d1/${id}/v3/data/`)]);
      const daily = [...v3Daily,...v2Daily], monthly = [...v3Monthly,...v2Monthly];
      services.push({ id, label: spec.label, storageAvailable: true,
        legacy: [...legacyDaily,...legacyMonthly].map(metadata),
        bytes: storedDataBytes + [...daily, ...monthly, ...legacyDaily, ...legacyMonthly].reduce((n, o) => n + o.size, 0),
        daily: daily.map(metadata).sort((a, b) => b.name.localeCompare(a.name)),
        monthly: monthly.map(metadata).sort((a, b) => b.name.localeCompare(a.name)) });
    } catch { services.push({ id, label: spec.label, storageAvailable: false }); }
  }
  try {
    const periods = (await listObjects(env.BACKUP, '_metadata/security-audit/')).map(o => ({
      month: o.customMetadata?.month, bytes: Number(o.customMetadata?.bytes || 0), rowCount: Number(o.customMetadata?.rowCount || 0),
      firstAt: o.customMetadata?.firstAt, lastAt: o.customMetadata?.lastAt
    })).sort((a, b) => String(b.month).localeCompare(String(a.month)));
    services.push({ id: 'security-audit', label: 'セキュリティ監査の長期保管', storageAvailable: true, retention: 'indefinite', periods,
      bytes: periods.reduce((n, p) => n + p.bytes, 0) });
  } catch { services.push({ id: 'security-audit', label: 'セキュリティ監査の長期保管', storageAvailable: false }); }
  const snapshot = { services, observedAt: new Date().toISOString() };
  if (services.every(s => s.storageAvailable)) await cache?.put(CACHE_KEY, Response.json(snapshot, { headers: { 'Cache-Control': 'max-age=21600' } })).catch(() => {});
  return snapshot;
}
export async function getBackupSnapshot(env, options = {}, cache = globalThis.caches?.default) {
  const snapshot = await storageSnapshot(env, options.refresh === true, cache);
  const services = [];
  for (const item of snapshot.services) {
    let health;
    try { health = await serviceStatus(env, item.id); } catch { health = { state: 'unavailable' }; }
    services.push({ ...item, ...health, available: item.storageAvailable && health.state !== 'unavailable',
      state: !item.storageAvailable && !['failed', 'partial', 'prune_failed'].includes(health.state) ? 'unavailable' : health.state });
  }
  return { ...snapshot, services, backupBytes: services.reduce((n, s) => n + (s.bytes || 0), 0) };
}
