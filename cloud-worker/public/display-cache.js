(function (global) {
  "use strict";
  const DB_NAME = "tcloud-display-cache";
  const DB_VERSION = 2;
  const STORE = "entries", META = "metadata", TOTALS = "totals";
  const LISTING_LIMIT_BYTES = 512 * 1024 * 1024;
  const THUMBNAIL_LIMIT_BYTES = 1024 * 1024 * 1024;
  const TOUCH_INTERVAL_MS = 60000;
  let databasePromise = null;
  let databaseRetryAfter = 0;
  const recentTouches = new Map();
  function supported() { return Boolean(global.indexedDB); }
  function entryKey(kind, scope, key) { return [scope, kind, String(key)]; }
  function thumbnailKey(fileId, version) { return `${Number(fileId)}:${String(version || "1")}`; }
  function encodedSize(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
  }
  async function getListing(scope, key) {
    if (!scope || !key) return null;
    return (await getEntry(entryKey("listing", scope, key), "listing"))?.payload || null;
  }
  async function putListing(scope, key, payload) {
    const sizeBytes = encodedSize(payload);
    if (!scope || !key || !payload || !sizeBytes || sizeBytes > LISTING_LIMIT_BYTES) return false;
    return putEntry({id: entryKey("listing", scope, key), kind: "listing", scope, cacheKey: key,
      sizeBytes, lastAccessed: Date.now()}, {payload}, LISTING_LIMIT_BYTES);
  }
  async function getThumbnail(scope, fileId, version) {
    if (!scope) return null;
    const id = entryKey("thumbnail", scope, thumbnailKey(fileId, version));
    const entry = await getEntry(id, "thumbnail");
    const blob = entry?.payload instanceof Blob ? entry.payload
      : entry?.payload instanceof ArrayBuffer ? new Blob([entry.payload], {type: entry.mimeType || ""}) : null;
    if (!blob?.size && entry) await deleteEntries([id]);
    return blob?.size ? blob : null;
  }
  async function putThumbnail(scope, fileId, version, blob) {
    if (!scope || !(blob instanceof Blob) || !blob.size || blob.size > THUMBNAIL_LIMIT_BYTES) return false;
    try {
      const key = thumbnailKey(fileId, version);
      // Device-local bytes avoid WebKit Blob serialization failures.
      const saved = await putEntry({id: entryKey("thumbnail", scope, key), kind: "thumbnail", scope,
        fileId: Number(fileId), cacheKey: key, sizeBytes: blob.size, lastAccessed: Date.now()},
        {payload: await blob.arrayBuffer(), mimeType: blob.type}, THUMBNAIL_LIMIT_BYTES);
      return saved;
    } catch { return false; }
  }
  async function removeThumbnail(scope, fileId, version) {
    if (scope) await deleteEntries([entryKey("thumbnail", scope, thumbnailKey(fileId, version))]);
  }
  async function removeFile(scope, fileId) {
    return scope ? removeMatching("scopeFile", [scope, Number(fileId)]) : 0;
  }
  async function clearScope(scope) {
    if (!scope) return 0;
    let count = 0;
    try {
      await transaction([STORE, META, TOTALS], "readwrite", async t => {
        const range = IDBKeyRange.bound([scope], [scope, []]);
        const deltas = new Map();
        await eachMetadata(t.objectStore(META), range, entry => {
          const delta = deltas.get(entry.kind) || {bytes: 0, count: 0};
          delta.bytes -= entry.sizeBytes; delta.count--; count++;
          deltas.set(entry.kind, delta);
        });
        // Compound primary keys allow one range delete per store, not thousands of IPC calls.
        t.objectStore(STORE).delete(range); t.objectStore(META).delete(range);
        for (const [kind, delta] of deltas) await changeTotal(t, kind, delta.bytes, delta.count);
      });
    } catch { return 0; }
    return count;
  }
  async function summary(scope) {
    const result = {listingBytes: 0, listingCount: 0, thumbnailBytes: 0, thumbnailCount: 0};
    try {
      await transaction([META], "readonly", async t => {
        const store = t.objectStore(META);
        await eachMetadata(scope ? store.index("scope") : store, scope ? prefixRange([scope]) : null, entry => {
          if (entry.kind !== "listing" && entry.kind !== "thumbnail") return;
          result[`${entry.kind}Bytes`] += entry.sizeBytes;
          result[`${entry.kind}Count`]++;
        });
      });
    } catch {}
    return result;
  }
  async function removeOldThumbnailVersions(scope, fileId, currentKey, t) {
    let bytes = 0, count = 0;
    await eachMetadata(t.objectStore(META).index("scopeFile"), prefixRange([scope, fileId]), entry => {
      if (entry.cacheKey === currentKey) return;
      t.objectStore(META).delete(entry.id); t.objectStore(STORE).delete(entry.id);
      bytes -= entry.sizeBytes; count--;
    });
    if (count) await changeTotal(t, "thumbnail", bytes, count);
  }
  async function removeMatching(index, key, predicate = () => true) {
    let removed = 0;
    try {
      await transaction([STORE, META, TOTALS], "readwrite", async t => {
        const deltas = new Map();
        await eachMetadata(t.objectStore(META).index(index), prefixRange(Array.isArray(key) ? key : [key]), entry => {
          if (!predicate(entry)) return;
          t.objectStore(META).delete(entry.id); t.objectStore(STORE).delete(entry.id);
          const delta = deltas.get(entry.kind) || {bytes: 0, count: 0};
          delta.bytes -= entry.sizeBytes; delta.count--;
          deltas.set(entry.kind, delta); removed++;
        });
        for (const [kind, delta] of deltas) await changeTotal(t, kind, delta.bytes, delta.count);
      });
    } catch { return 0; }
    return removed;
  }
  async function trim(kind, limitBytes) {
    // Atomic counters eliminate full scans per insert. Only evicted metadata is read.
    await transaction([STORE, META, TOTALS], "readwrite", async t => {
      const total = await requestResult(t.objectStore(TOTALS).get(kind));
      if (!total || total.bytes <= limitBytes) return;
      await eachMetadata(t.objectStore(META).index("kindAccess"),
        IDBKeyRange.bound([kind, 0, ""], [kind, Number.MAX_SAFE_INTEGER, "\uffff"]), entry => {
        if (total.bytes <= limitBytes) return false;
        t.objectStore(META).delete(entry.id); t.objectStore(STORE).delete(entry.id);
        total.bytes -= entry.sizeBytes; total.count--;
      });
      t.objectStore(TOTALS).put(total);
    });
  }
  async function touch(id) {
    const key = JSON.stringify(id), now = Date.now();
    if (now - (recentTouches.get(key) || 0) < TOUCH_INTERVAL_MS) return;
    recentTouches.delete(key); recentTouches.set(key, now);
    if (recentTouches.size > 2048) recentTouches.delete(recentTouches.keys().next().value);
    try {
      await transaction([META], "readwrite", async t => {
        const store = t.objectStore(META), entry = await requestResult(store.get(id));
        if (entry && Date.now() - entry.lastAccessed >= TOUCH_INTERVAL_MS) store.put({...entry, lastAccessed: Date.now()});
      });
    } catch {}
  }
  async function getEntry(id, kind) {
    try {
      if (!supported()) return null;
      const db = await openDatabase();
      // One payload read on the critical display path. The compound key includes
      // the complete scope and kind; payload and metadata mutations are atomic.
      const entry = await requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
      if (!Array.isArray(entry?.id) || entry.id[1] !== kind) return null;
      void touch(id);
      return entry;
    } catch { return null; }
  }
  async function putEntry(meta, data, limitBytes) {
    try {
      await transaction([STORE, META, TOTALS], "readwrite", async t => {
        const previous = await requestResult(t.objectStore(META).get(meta.id));
        t.objectStore(STORE).put({id: meta.id, ...data}); t.objectStore(META).put(meta);
        await changeTotal(t, meta.kind, meta.sizeBytes - (previous?.sizeBytes || 0), previous ? 0 : 1);
        if (meta.kind === "thumbnail") await removeOldThumbnailVersions(meta.scope, meta.fileId, meta.cacheKey, t);
      });
      await trim(meta.kind, limitBytes);
      return true;
    } catch { return false; }
  }
  async function deleteEntries(ids) {
    try {
      await transaction([STORE, META, TOTALS], "readwrite", async t => {
        for (const id of ids) {
          const previous = await requestResult(t.objectStore(META).get(id));
          t.objectStore(STORE).delete(id); t.objectStore(META).delete(id);
          if (previous) await changeTotal(t, previous.kind, -previous.sizeBytes, -1);
        }
      });
    } catch {}
  }
  async function changeTotal(t, kind, bytes, count) {
    const store = t.objectStore(TOTALS);
    const total = await requestResult(store.get(kind)) || {kind, bytes: 0, count: 0};
    total.bytes = Math.max(0, total.bytes + bytes); total.count = Math.max(0, total.count + count);
    store.put(total);
  }
  function prefixRange(prefix) { return IDBKeyRange.bound([...prefix, ""], [...prefix, "\uffff"]); }
  async function eachMetadata(source, range, visit) {
    // Bounded batches of small metadata records avoid both payload scans and
    // WebKit's per-record cursor IPC. Unique trailing IDs make paging lossless.
    for (;;) {
      const batch = await requestResult(source.getAll(range, 128));
      for (const entry of batch) if (visit(entry) === false) return;
      if (batch.length < 128) return;
      const last = batch[batch.length - 1];
      const key = Array.isArray(source.keyPath) ? source.keyPath.map(field => last[field]) : last[source.keyPath];
      range = range?.upper !== undefined ? IDBKeyRange.bound(key, range.upper, true, range.upperOpen) : IDBKeyRange.lowerBound(key, true);
    }
  }
  function openDatabase() {
    if (databasePromise) return databasePromise;
    if (Date.now() < databaseRetryAfter) return Promise.reject(new Error("表示キャッシュを再試行待ちです。"));
    databasePromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        // Rebuild only the disposable v1 display cache, without loading old blobs.
        // Offline encrypted files and private keys live in separate, untouched DBs.
        for (const name of [STORE, META, TOTALS]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        db.createObjectStore(STORE, {keyPath: "id"});
        const meta = db.createObjectStore(META, {keyPath: "id"});
        meta.createIndex("scope", ["scope", "kind", "cacheKey"], {unique: true});
        meta.createIndex("scopeFile", ["scope", "fileId", "cacheKey"], {unique: true});
        meta.createIndex("kindAccess", ["kind", "lastAccessed", "scope", "cacheKey"], {unique: true});
        db.createObjectStore(TOTALS, {keyPath: "kind"});
      };
      request.onblocked = () => { blocked = true; reject(new Error("表示キャッシュの更新待ちです。")); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); databasePromise = null; };
        db.onclose = () => { databasePromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => { databasePromise = null; databaseRetryAfter = Date.now() + 5000; throw error; });
    return databasePromise;
  }
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transaction(stores, mode, action) {
    if (!supported()) throw new Error("表示キャッシュを利用できません。");
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error || new Error("表示キャッシュ処理を中止しました。"));
      Promise.resolve().then(() => action(t)).catch(error => { try { t.abort(); } catch {} reject(error); });
    });
  }
  global.TCloudDisplayCache = Object.freeze({supported, getListing, putListing, getThumbnail, putThumbnail,
    removeThumbnail, removeFile, clearScope, summary,
    limits: Object.freeze({listingBytes: LISTING_LIMIT_BYTES, thumbnailBytes: THUMBNAIL_LIMIT_BYTES})});
})(globalThis);
