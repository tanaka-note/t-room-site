(function (global) {
  "use strict";

  const DB_NAME = "tcloud-display-cache";
  const DB_VERSION = 1;
  const STORE = "entries";
  const LISTING_LIMIT_BYTES = 512 * 1024 * 1024;
  const THUMBNAIL_LIMIT_BYTES = 1024 * 1024 * 1024;
  let databasePromise = null;

  function supported() {
    return Boolean(global.indexedDB);
  }

  async function getListing(scope, key) {
    const entry = await getEntry(entryKey("listing", scope, key));
    if (!entry || entry.kind !== "listing") return null;
    void touch(entry);
    return entry.payload || null;
  }

  async function putListing(scope, key, payload) {
    if (!supported() || !scope || !key || !payload) return false;
    const sizeBytes = encodedSize(payload);
    if (!sizeBytes || sizeBytes > LISTING_LIMIT_BYTES) return false;
    await putEntry({
      id: entryKey("listing", scope, key),
      kind: "listing",
      scope,
      cacheKey: key,
      payload,
      sizeBytes,
      lastAccessed: Date.now()
    });
    await trim("listing", LISTING_LIMIT_BYTES);
    return true;
  }

  async function getThumbnail(scope, fileId, version) {
    const key = thumbnailKey(fileId, version);
    const entry = await getEntry(entryKey("thumbnail", scope, key));
    if (!entry || entry.kind !== "thumbnail" || !(entry.payload instanceof Blob)) return null;
    void touch(entry);
    return entry.payload;
  }

  async function putThumbnail(scope, fileId, version, blob) {
    if (!supported() || !scope || !(blob instanceof Blob) || !blob.size || blob.size > THUMBNAIL_LIMIT_BYTES) return false;
    const key = thumbnailKey(fileId, version);
    await putEntry({
      id: entryKey("thumbnail", scope, key),
      kind: "thumbnail",
      scope,
      cacheKey: key,
      fileId: Number(fileId),
      payload: blob,
      sizeBytes: Number(blob.size),
      lastAccessed: Date.now()
    });
    await removeOldThumbnailVersions(scope, Number(fileId), key);
    await trim("thumbnail", THUMBNAIL_LIMIT_BYTES);
    return true;
  }

  async function removeFile(scope, fileId) {
    if (!supported()) return 0;
    const entries = await listEntries();
    const ids = entries
      .filter((entry) => entry.scope === scope && entry.kind === "thumbnail" && Number(entry.fileId) === Number(fileId))
      .map((entry) => entry.id);
    await deleteEntries(ids);
    return ids.length;
  }

  async function clearScope(scope) {
    if (!supported()) return 0;
    const entries = await listEntries();
    const ids = entries.filter((entry) => entry.scope === scope).map((entry) => entry.id);
    await deleteEntries(ids);
    return ids.length;
  }

  async function summary(scope) {
    const entries = (await listEntries()).filter((entry) => !scope || entry.scope === scope);
    return entries.reduce((result, entry) => {
      const bytes = Number(entry.sizeBytes || 0);
      if (entry.kind === "thumbnail") {
        result.thumbnailBytes += bytes;
        result.thumbnailCount += 1;
      } else {
        result.listingBytes += bytes;
        result.listingCount += 1;
      }
      return result;
    }, { listingBytes: 0, listingCount: 0, thumbnailBytes: 0, thumbnailCount: 0 });
  }

  function entryKey(kind, scope, key) {
    return `${kind}:${scope}:${key}`;
  }

  function thumbnailKey(fileId, version) {
    return `${Number(fileId)}:${String(version || "1")}`;
  }

  function encodedSize(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return 0;
    }
  }

  async function removeOldThumbnailVersions(scope, fileId, currentKey) {
    const entries = await listEntries();
    const ids = entries
      .filter((entry) => entry.kind === "thumbnail"
        && entry.scope === scope
        && Number(entry.fileId) === Number(fileId)
        && entry.cacheKey !== currentKey)
      .map((entry) => entry.id);
    await deleteEntries(ids);
  }

  async function trim(kind, limitBytes) {
    const entries = (await listEntries())
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => Number(a.lastAccessed || 0) - Number(b.lastAccessed || 0));
    let total = entries.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
    const ids = [];
    for (const entry of entries) {
      if (total <= limitBytes) break;
      ids.push(entry.id);
      total -= Number(entry.sizeBytes || 0);
    }
    await deleteEntries(ids);
  }

  async function touch(entry) {
    try {
      await putEntry({ ...entry, lastAccessed: Date.now() });
    } catch {}
  }

  async function getEntry(id) {
    if (!supported()) return null;
    const db = await openDatabase();
    return requestResult(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  }

  async function putEntry(entry) {
    const db = await openDatabase();
    await transactionDone(db.transaction(STORE, "readwrite"), (store) => store.put(entry));
  }

  async function listEntries() {
    if (!supported()) return [];
    const db = await openDatabase();
    return requestResult(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  }

  async function deleteEntries(ids) {
    if (!ids.length || !supported()) return;
    const db = await openDatabase();
    await transactionDone(db.transaction(STORE, "readwrite"), (store) => ids.forEach((id) => store.delete(id)));
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = global.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("kind", "kind", { unique: false });
          store.createIndex("scope", "scope", { unique: false });
          store.createIndex("lastAccessed", "lastAccessed", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("表示キャッシュを開けませんでした。"));
    });
    return databasePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("表示キャッシュを読み込めませんでした。"));
    });
  }

  function transactionDone(transaction, action) {
    return new Promise((resolve, reject) => {
      action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("表示キャッシュを保存できませんでした。"));
      transaction.onabort = () => reject(transaction.error || new Error("表示キャッシュの保存を中止しました。"));
    });
  }

  global.TCloudDisplayCache = Object.freeze({
    supported,
    getListing,
    putListing,
    getThumbnail,
    putThumbnail,
    removeFile,
    clearScope,
    summary,
    limits: Object.freeze({ listingBytes: LISTING_LIMIT_BYTES, thumbnailBytes: THUMBNAIL_LIMIT_BYTES })
  });
})(globalThis);
