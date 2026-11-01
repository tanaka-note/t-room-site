// Metadata only. This integration never reads backup bodies or writes to R2/D1.
const CACHE_KEY = "https://diary-backup.internal/browser-summary-v3";
const CACHE_SECONDS = 6 * 60 * 60;
const PREFIXES = { daily: "v8/daily/", monthly: "v8/monthly/", photo: "media/verified-photos/", receipts: "media/photo-receipts/", versions: "media/photo-versions/", incidents: "media/photo-issues/", legacyV7Daily: "v7/daily/", legacyV7Monthly: "v7/monthly/", legacyDaily: "daily/", legacyMonthly: "monthly/", legacyPhoto: "media/formal-photos/" };
const isMedia = kind => ['photo','receipts','versions','incidents','legacyPhoto'].includes(kind);

async function photoSummary(bucket) {
  try {
    const object = await bucket.head('_metadata/diary-photos/copy.json.gz');
    if (!object) return { available: true, observed: false };
    const p = object.customMetadata || {};
    if (p.format !== 'troom-photo-job-v1') throw new Error('InvalidPhotoSummary');
    const result = { available: true, observed: true, countsComplete: p.countsComplete === 'true', complete: p.complete === 'true' };
    for (const key of ['scanned','backedUp','pending','verificationPending','failed','corrupt','missing','bytes','total','unknown','copied']) {
      const value = Number(p[key]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('InvalidPhotoSummary');
      result[key] = value;
    }
    for (const key of ['oversized','retryPending','retriesAttempted']) {
      const value = Number(p[key] ?? 0);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('InvalidPhotoSummary');
      result[key] = value;
    }
    for (const key of ['lastRunAt','lastFullCopyAt','cycleStartedAt']) result[key] = Number.isFinite(Date.parse(p[key])) ? p[key] : null;
    return result;
  } catch { return { available: false, observed: false }; }
}

export async function scanBackupMetadata(bucket, now = Date.now()) {
  if (!bucket) throw new Error("Backup storage unavailable");
  const groups = {};
  for (const [kind, prefix] of Object.entries(PREFIXES)) {
    const group = { available: true, bytes: 0, objectCount: 0, lastUpdatedAt: null, ...(isMedia(kind) ? {} : { objects: [] }) };
    try {
      let cursor;
      do {
        const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}),
          ...(isMedia(kind) ? {} : { include: ["customMetadata", "httpMetadata"] }) });
        for (const object of page.objects) {
          group.bytes += object.size;
          group.objectCount += 1;
          if(group.objectCount>20000) throw new Error("SnapshotTooLarge");
          const updatedAt = object.uploaded.toISOString();
          if (!group.lastUpdatedAt || updatedAt > group.lastUpdatedAt) group.lastUpdatedAt = updatedAt;
          if (group.objects) {
            const metadata = object.customMetadata || {};
            group.objects.push({ name: object.key.slice(prefix.length), sizeBytes: object.size, updatedAt,
              format: metadata.format || null, japanDate: metadata.japanDate || null,
              backupScope: metadata.backupScope === 'd1-only' ? 'd1-only' : null,
              mediaComplete: kind.startsWith("legacy") ? null : metadata.mediaComplete === "true" ? true : metadata.mediaComplete === "false" ? false : null,
              contentType: object.httpMetadata?.contentType || null, contentEncoding: object.httpMetadata?.contentEncoding || null });
          }
        }
        if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error("Incomplete backup listing");
        cursor = page.truncated ? page.cursor : null;
      } while (cursor);
      group.objects?.sort((a, b) => b.name.localeCompare(a.name));
      groups[kind] = group;
    } catch {
      groups[kind] = { available: false, bytes: null, objectCount: null, lastUpdatedAt: null, ...(group.objects ? { objects: [] } : {}) };
    }
  }
  if (Object.values(groups).every(g => g.available === false)) throw new Error('Backup storage unavailable');
  const latest = groups.daily.objects.filter(o => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(o.name))[0] || null;
  return { ...groups, photoSummary: await photoSummary(bucket), d1Bytes: groups.daily.bytes + groups.monthly.bytes,
    d1Available: groups.daily.available && groups.monthly.available, storagePartial: Object.values(groups).some(g => !g.available),
    backupBytes: Object.values(groups).reduce((sum, g) => sum + g.bytes, 0),
    backupObjectCount: Object.values(groups).reduce((sum, g) => sum + g.objectCount, 0),
    lastBackupAt: latest?.updatedAt || null, latestBackup: latest?.name || null,
    mediaComplete: latest?.mediaComplete ?? null, observedAt: new Date(now).toISOString() };
}

export async function getBackupSnapshot(env, { refresh = false } = {}, cache = globalThis.caches?.default) {
  const cached = await cache?.match(CACHE_KEY).catch(() => null);
  if (cached) {
    const snapshot = await cached.json();
    // Avoid repeated scans on double clicks. A manual refresh after one minute
    // bypasses the six-hour cache; the UI always shows the observation time.
    if (!refresh || Date.now() - Date.parse(snapshot.observedAt) < 60_000) return snapshot;
  }
  const snapshot = await scanBackupMetadata(env.BACKUP);
  await cache?.put(CACHE_KEY, new Response(JSON.stringify(snapshot), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` }
  })).catch(() => {});
  return snapshot;
}
