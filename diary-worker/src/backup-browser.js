// Metadata only. This integration never reads backup bodies or writes to R2/D1.
const CACHE_KEY = "https://diary-backup.internal/browser-summary-v1";
const CACHE_SECONDS = 6 * 60 * 60;
const PREFIXES = { daily: "daily/", monthly: "monthly/", photo: "media/formal-photos/" };

export async function scanBackupMetadata(bucket, now = Date.now()) {
  if (!bucket) throw new Error("Backup storage unavailable");
  const groups = {};
  for (const [kind, prefix] of Object.entries(PREFIXES)) {
    const group = { bytes: 0, objectCount: 0, lastUpdatedAt: null, ...(kind === "photo" ? {} : { objects: [] }) };
    let cursor;
    do {
      const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}),
        ...(kind === "photo" ? {} : { include: ["customMetadata", "httpMetadata"] }) });
      for (const object of page.objects) {
        group.bytes += object.size;
        group.objectCount += 1;
        const updatedAt = object.uploaded.toISOString();
        if (!group.lastUpdatedAt || updatedAt > group.lastUpdatedAt) group.lastUpdatedAt = updatedAt;
        if (group.objects) {
          const metadata = object.customMetadata || {};
          group.objects.push({ name: object.key.slice(prefix.length), sizeBytes: object.size, updatedAt,
            format: metadata.format || null, japanDate: metadata.japanDate || null,
            mediaComplete: metadata.mediaComplete === "true" ? true : metadata.mediaComplete === "false" ? false : null,
            contentType: object.httpMetadata?.contentType || null, contentEncoding: object.httpMetadata?.contentEncoding || null });
        }
      }
      if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error("Incomplete backup listing");
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    group.objects?.sort((a, b) => b.name.localeCompare(a.name));
    groups[kind] = group;
  }
  const latest = groups.daily.objects.filter(o => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(o.name))[0] || null;
  return { ...groups, backupBytes: Object.values(groups).reduce((sum, g) => sum + g.bytes, 0),
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
