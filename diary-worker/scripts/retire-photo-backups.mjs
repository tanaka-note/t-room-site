import { createHash } from 'node:crypto';

const ACCOUNT = '277e86de986181599ce0db2b3ca1f186';
const BASE = `/accounts/${ACCOUNT}`;
const OBJECTS = `${BASE}/r2/buckets/t-room-diary-backups/objects`;
const MEDIA = `${BASE}/r2/buckets/t-room-diary-media/objects`;
const SCHEDULES = `${BASE}/workers/scripts/t-room-diary/schedules`;
export const PHOTO_PREFIXES = Object.freeze([
  'media/formal-photos/', 'media/verified-photos/', 'media/photo-receipts/',
  'media/photo-versions/', 'media/photo-issues/', '_metadata/diary-photos/'
]);
const PHOTO_CRONS = ['55 18 * * *', '45 0-2,19-23 * * *', '5,15,25,35,55 19,20 * * *'];
const isPhoto = key => typeof key === 'string' && PHOTO_PREFIXES.some(prefix => key.startsWith(prefix) && key.length > prefix.length);
const fingerprint = objects => createHash('sha256').update(JSON.stringify(objects.map(o => [o.key, o.etag, o.size]).sort((a,b) => a[0].localeCompare(b[0])))).digest('hex');

// All mutations pass this allowlist. There is deliberately no generic bucket,
// prefix-delete endpoint, object upload, D1 write or MEDIA mutation capability.
export function assertOperation({ method = 'GET', path, body, query }) {
  if (method === 'GET' && [OBJECTS, MEDIA, SCHEDULES].includes(path)) return;
  if (method === 'PUT' && path === SCHEDULES && JSON.stringify(body) === JSON.stringify([{ cron: '25 18 * * *' }]) && !query) return;
  if (method === 'DELETE' && path === OBJECTS && !query && Array.isArray(body)
      && body.length > 0 && body.length <= 1000 && body.every(isPhoto)) return;
  throw new Error('RetirementOperationRejected');
}

export async function retirePhotoBackups({ request, apply = false, now = Date.now, log = console.log }) {
  const call = async options => { assertOperation(options); return request(options); };
  const list = async (path, query = {}) => {
    const all = []; let cursor;
    do {
      const result = await call({ method: 'GET', path, query: { per_page: 1000, ...query, ...(cursor ? { cursor } : {}) } });
      all.push(...result.result);
      if (result.result_info?.is_truncated && (!result.result_info.cursor || result.result_info.cursor === cursor)) throw new Error('IncompleteInventory');
      cursor = result.result_info?.is_truncated ? result.result_info.cursor : null;
    } while (cursor);
    return all;
  };
  const schedules = (await call({ method: 'GET', path: SCHEDULES })).result.schedules.map(s => s.cron);
  if (!schedules.includes('25 18 * * *') || schedules.some(c => c !== '25 18 * * *' && !PHOTO_CRONS.includes(c))) throw new Error('UnexpectedDiarySchedules');
  if (apply) {
    // Cron changes propagate asynchronously. Retire outside the photo execution
    // window, including a twenty-minute margin, so no old trigger can restart.
    const jst = new Date(now() + 9 * 3600000);
    const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    if (minute >= 3 * 60 + 35 && minute < 12 * 60 + 5) throw new Error('PhotoCronPropagationWindow');
    await call({ method: 'PUT', path: SCHEDULES, body: [{ cron: '25 18 * * *' }] });
    const actual = (await call({ method: 'GET', path: SCHEDULES })).result.schedules.map(s => s.cron);
    if (JSON.stringify(actual) !== JSON.stringify(['25 18 * * *'])) throw new Error('ScheduleStopUnconfirmed');
    log('Photo Cron triggers stopped; daily D1 Cron retained.');
  }
  const [inventory, mediaSample] = await Promise.all([
    list(OBJECTS), call({ method: 'GET', path: MEDIA, query: { per_page: 3 } }).then(r => r.result)
  ]);
  const targets = inventory.filter(o => isPhoto(o.key));
  const protectedObjects = inventory.filter(o => !isPhoto(o.key));
  const summary = PHOTO_PREFIXES.map(prefix => {
    const objects = targets.filter(o => o.key.startsWith(prefix));
    return { prefix, count: objects.length, bytes: objects.reduce((sum,o) => sum + o.size, 0) };
  });
  log(JSON.stringify({ apply, summary, protectedBackupObjects: protectedObjects.length, protectedFingerprint: fingerprint(protectedObjects), mainMediaSampleCount: mediaSample.length }));
  if (!apply) return { summary };
  // An old in-flight invocation may retain the previous schedule configuration.
  // Wait for its five-minute lease/grace period before removing its state.
  if (targets.some(o => o.key.startsWith('_metadata/diary-photos/') && now() - Date.parse(o.last_modified) < 6 * 60000)) throw new Error('PhotoJobStillActiveRetryAfterGrace');
  const batches = [];
  for (let i = 0; i < targets.length; i += 1000) batches.push(targets.slice(i, i + 1000).map(o => o.key));
  // Bulk deletes start promptly, with no deliberate delay between requests.
  for (let i = 0; i < batches.length; i += 8) {
    await Promise.all(batches.slice(i, i + 8).map(body => call({ method: 'DELETE', path: OBJECTS, body })));
  }
  const [after, mediaAfter] = await Promise.all([
    list(OBJECTS), call({ method: 'GET', path: MEDIA, query: { per_page: 3 } }).then(r => r.result)
  ]);
  if (after.some(o => isPhoto(o.key))) throw new Error('PhotoBackupObjectsRemain');
  if (fingerprint(after) !== fingerprint(protectedObjects)) throw new Error('ProtectedBackupInventoryChanged');
  if (fingerprint(mediaAfter) !== fingerprint(mediaSample)) throw new Error('MainMediaSampleChanged');
  const result = { deletedObjects: targets.length, deletedBytes: targets.reduce((n,o) => n + o.size, 0), photoBackupObjectsRemaining: 0, protectedBackupObjectsUnchanged: true, mainMediaSampleUnchanged: true, summary };
  log(JSON.stringify(result));
  return result;
}
