(function (global) {
  "use strict";

  const DB_NAME = "tcloud-offline-storage";
  const DB_VERSION = 1;
  const ENTRY_STORE = "entries";
  const ROOT_DIRECTORY = "tcloud-media-v1";
  const DEFAULT_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
  const MAX_CACHE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
  const OFFLINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  let cacheLimitBytes = DEFAULT_CACHE_LIMIT_BYTES;
  let databasePromise = null;
  let rootPromise = null;

  function supported() {
    return Boolean(global.indexedDB && global.navigator?.storage?.getDirectory);
  }

  async function requestPersistence() {
    if (!global.navigator?.storage?.persist) return { supported: false, persistent: false };
    try {
      if (await global.navigator.storage.persisted?.()) return { supported: true, persistent: true };
      return { supported: true, persistent: Boolean(await global.navigator.storage.persist()) };
    } catch {
      return { supported: true, persistent: false };
    }
  }

  async function storageEstimate() {
    if (!global.navigator?.storage?.estimate) return { usage: 0, quota: 0, available: 0 };
    const estimate = await global.navigator.storage.estimate();
    const usage = Number(estimate.usage || 0);
    const quota = Number(estimate.quota || 0);
    return { usage, quota, available: Math.max(0, quota - usage) };
  }

  function createStorageId(accountScope, rootFolderId, fileId, version) {
    const account = String(accountScope || "").replace(/[^a-z0-9_-]/gi, "_").slice(0, 48);
    const root = Number(rootFolderId);
    const file = Number(fileId);
    if (!account || !Number.isSafeInteger(root) || root <= 0 || !Number.isSafeInteger(file) || file <= 0) {
      throw new Error("端末保存するファイル情報を確認できません。");
    }
    return `${account}:${root}:${file}:${String(version || "1").slice(0, 80)}`;
  }

  async function getEntry(id) {
    const db = await openDatabase();
    return requestResult(db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).get(id));
  }

  async function listEntries(accountScope, rootFolderId, options = {}) {
    await cleanupExpired();
    const db = await openDatabase();
    const records = await requestResult(db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).getAll());
    return (records || []).filter((entry) => String(entry.accountScope) === String(accountScope)
      && Number(entry.rootFolderId) === Number(rootFolderId)
      && (!options.offlineOnly || entry.offline === true));
  }

  async function summary(accountScope, rootFolderId) {
    const entries = await listEntries(accountScope, rootFolderId);
    const offline = entries.filter((entry) => entry.offline && entry.complete);
    const cacheBytes = entries.filter((entry) => !entry.offline).reduce((total, entry) => total + cachedBytes(entry), 0);
    const offlineBytes = offline.reduce((total, entry) => total + Number(entry.encryptedSizeBytes || entry.cachedBytes || 0), 0);
    const nextExpiry = offline.map((entry) => Number(entry.expiresAt || 0)).filter(Boolean).sort((a, b) => a - b)[0] || 0;
    return { cacheBytes, offlineBytes, offlineCount: offline.length, nextExpiry };
  }

  async function beginEntry(record) {
    ensureSupported();
    const previous = await getEntry(record.id);
    const now = Date.now();
    const entry = {
      ...(previous || {}),
      ...record,
      schemaVersion: 1,
      chunks: previous?.chunks || {},
      cachedBytes: Number(previous?.cachedBytes || 0),
      createdAt: Number(previous?.createdAt || now),
      lastAccessedAt: now,
      offline: Boolean(previous?.offline || record.offline),
      complete: Boolean(previous?.complete && previous?.version === record.version),
      status: previous?.complete && previous?.version === record.version ? "complete" : "saving"
    };
    await putEntry(entry);
    return entry;
  }

  async function markOfflineComplete(id, completedAt = Date.now()) {
    const entry = await getEntry(id);
    if (!entry) throw new Error("端末保存情報が見つかりません。");
    const expected = Number(entry.chunkCount || 0);
    const stored = Object.keys(entry.chunks || {}).length;
    if (!expected || stored !== expected || cachedBytes(entry) < Number(entry.encryptedSizeBytes || 0)) {
      throw new Error("すべての暗号化データを確認できないため、保存を完了できません。");
    }
    entry.offline = true;
    entry.complete = true;
    entry.status = "complete";
    entry.completedAt = completedAt;
    entry.expiresAt = completedAt + OFFLINE_RETENTION_MS;
    entry.lastAccessedAt = completedAt;
    await putEntry(entry);
    return entry;
  }

  async function markInterrupted(id, message = "中断") {
    const entry = await getEntry(id);
    if (!entry) return;
    entry.status = "interrupted";
    entry.lastError = String(message || "中断").slice(0, 300);
    await putEntry(entry);
  }

  async function putChunk(id, index, bytes, options = {}) {
    ensureSupported();
    const entry = await getEntry(id);
    if (!entry) throw new Error("端末保存情報が見つかりません。");
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const expectedBytes = Number(options.expectedBytes || data.byteLength);
    if (data.byteLength !== expectedBytes) throw new Error("暗号化チャンクの容量が一致しません。");
    const directory = await entryDirectory(id, true);
    const fileHandle = await directory.getFileHandle(chunkFilename(index), { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch {}
      throw error;
    }
    const updated = await mutateEntry(id, (current) => {
      if (!current) throw new Error("端末保存情報を確認できません。");
      const previousBytes = Number(current.chunks?.[index]?.bytes || 0);
      current.chunks = { ...(current.chunks || {}), [index]: { bytes: data.byteLength, touchedAt: Date.now() } };
      current.cachedBytes = Math.max(0, Number(current.cachedBytes || 0) - previousBytes + data.byteLength);
      current.lastAccessedAt = Date.now();
      return current;
    });
    if (!updated.offline && options.enforceCacheLimit !== false) await enforceCacheLimit(id, index, updated.accountScope);
    return data.byteLength;
  }

  async function getChunk(id, index) {
    const entry = await getEntry(id);
    if (!entry?.chunks?.[index]) return null;
    try {
      const directory = await entryDirectory(id, false);
      const handle = await directory.getFileHandle(chunkFilename(index));
      const file = await handle.getFile();
      const expected = Number(entry.chunks[index].bytes || 0);
      if (!expected || file.size !== expected) {
        await removeChunk(id, index);
        return null;
      }
      await mutateEntry(id, (current) => {
        if (!current?.chunks?.[index]) return current;
        current.chunks[index].touchedAt = Date.now();
        current.lastAccessedAt = Date.now();
        return current;
      });
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      await removeChunk(id, index).catch(() => {});
      return null;
    }
  }

  async function removeEntry(id) {
    const db = await openDatabase();
    await transactionDone(db, "readwrite", (store) => store.delete(id));
    try {
      const root = await mediaRoot();
      await root.removeEntry(await directoryName(id), { recursive: true });
    } catch {}
  }

  async function removeEntries(ids) {
    for (const id of [...new Set(ids || [])]) await removeEntry(id);
  }

  async function clearCache(accountScope, rootFolderId) {
    const entries = await listEntries(accountScope, rootFolderId);
    const removable = entries.filter((entry) => !entry.offline).map((entry) => entry.id);
    await removeEntries(removable);
    return removable.length;
  }

  async function removeFile(accountScope, fileId) {
    const db = await openDatabase();
    const entries = await requestResult(db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).getAll());
    const removable = (entries || []).filter((entry) => String(entry.accountScope) === String(accountScope)
      && Number(entry.fileId) === Number(fileId)).map((entry) => entry.id);
    await removeEntries(removable);
    return removable.length;
  }

  async function removeRoot(accountScope, rootFolderId) {
    const entries = await listEntries(accountScope, rootFolderId);
    await removeEntries(entries.map((entry) => entry.id));
    return entries.length;
  }

  async function cleanupExpired(now = Date.now()) {
    if (!supported()) return [];
    const db = await openDatabase();
    const entries = await requestResult(db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).getAll());
    const expired = (entries || []).filter((entry) => entry.offline && Number(entry.expiresAt || 0) <= now).map((entry) => entry.id);
    await removeEntries(expired);
    return expired;
  }

  function setCacheLimitBytes(value) {
    const requested = Number(value);
    cacheLimitBytes = Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_CACHE_LIMIT_BYTES, Math.floor(requested))
      : DEFAULT_CACHE_LIMIT_BYTES;
    return cacheLimitBytes;
  }

  function getCacheLimitBytes() {
    return cacheLimitBytes;
  }

  async function enforceCacheLimit(protectedId = "", protectedIndex = -1, accountScope = "") {
    const db = await openDatabase();
    const entries = await requestResult(db.transaction(ENTRY_STORE).objectStore(ENTRY_STORE).getAll());
    const scopedEntries = (entries || []).filter((entry) => !accountScope || String(entry.accountScope) === String(accountScope));
    let total = scopedEntries.filter((entry) => !entry.offline).reduce((sum, entry) => sum + cachedBytes(entry), 0);
    if (total <= cacheLimitBytes) return;
    const candidates = [];
    for (const entry of scopedEntries) {
      if (entry.offline) continue;
      for (const [indexText, chunk] of Object.entries(entry.chunks || {})) {
        const index = Number(indexText);
        if (entry.id === protectedId && index === Number(protectedIndex)) continue;
        candidates.push({ id: entry.id, index, bytes: Number(chunk.bytes || 0), touchedAt: Number(chunk.touchedAt || entry.lastAccessedAt || 0) });
      }
    }
    candidates.sort((a, b) => a.touchedAt - b.touchedAt);
    for (const candidate of candidates) {
      if (total <= cacheLimitBytes) break;
      await removeChunk(candidate.id, candidate.index);
      total -= candidate.bytes;
    }
  }

  async function removeChunk(id, index) {
    const entry = await getEntry(id);
    if (!entry?.chunks?.[index]) return;
    const bytes = Number(entry.chunks[index].bytes || 0);
    try {
      const directory = await entryDirectory(id, false);
      await directory.removeEntry(chunkFilename(index));
    } catch {}
    await mutateEntry(id, (current) => {
      if (!current?.chunks?.[index]) return current;
      const currentBytes = Number(current.chunks[index].bytes || bytes);
      delete current.chunks[index];
      current.cachedBytes = Math.max(0, Number(current.cachedBytes || 0) - currentBytes);
      current.complete = false;
      return current;
    });
  }

  async function putEntry(entry) {
    const db = await openDatabase();
    await transactionDone(db, "readwrite", (store) => store.put(entry));
  }

  async function mutateEntry(id, mutate) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ENTRY_STORE, "readwrite");
      const store = transaction.objectStore(ENTRY_STORE);
      const request = store.get(id);
      let result;
      request.onsuccess = () => {
        try {
          result = mutate(request.result);
          if (result) store.put(result);
        } catch (error) {
          reject(error);
          transaction.abort();
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("端末保存情報を更新できませんでした。"));
    });
  }

  async function openDatabase() {
    ensureSupported();
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = global.indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE, { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return databasePromise;
  }

  async function mediaRoot() {
    ensureSupported();
    if (!rootPromise) rootPromise = global.navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(ROOT_DIRECTORY, { create: true }));
    return rootPromise;
  }

  async function entryDirectory(id, create) {
    const root = await mediaRoot();
    return root.getDirectoryHandle(await directoryName(id), { create });
  }

  async function directoryName(id) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(id))));
    let value = "";
    for (const byte of digest) value += byte.toString(16).padStart(2, "0");
    return value;
  }

  function chunkFilename(index) {
    return `chunk-${String(Number(index)).padStart(8, "0")}.bin`;
  }

  function cachedBytes(entry) {
    return Number(entry?.cachedBytes || Object.values(entry?.chunks || {}).reduce((sum, item) => sum + Number(item.bytes || 0), 0));
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(db, mode, callback) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(ENTRY_STORE, mode);
      callback(transaction.objectStore(ENTRY_STORE));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function ensureSupported() {
    if (!supported()) throw new Error("このブラウザは端末キャッシュに対応していません。");
  }

  global.TCloudOffline = Object.freeze({
    DEFAULT_CACHE_LIMIT_BYTES,
    MAX_CACHE_LIMIT_BYTES,
    OFFLINE_RETENTION_MS,
    supported,
    requestPersistence,
    storageEstimate,
    createStorageId,
    getEntry,
    listEntries,
    summary,
    beginEntry,
    markOfflineComplete,
    markInterrupted,
    putChunk,
    getChunk,
    removeEntry,
    removeEntries,
    clearCache,
    removeFile,
    removeRoot,
    cleanupExpired,
    setCacheLimitBytes,
    getCacheLimitBytes,
    enforceCacheLimit
  });
})(globalThis);
