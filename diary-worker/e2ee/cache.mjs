import { validateSnapshot } from "./record.mjs";
// This candidate persists ciphertext only, never PRF, CryptoKeys or plaintext.
// It must run on the dedicated diary origin before production use.
export async function openCipherCache(name = "tlain-diary-encrypted-v1") {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("snapshots");
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("CacheUnavailable"));
  });
  const operation = (mode, callback) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", mode);
      const req = callback(tx.objectStore("snapshots"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(new Error("CacheUnavailable"));
    });
  return {
    get: (key) => operation("readonly", (store) => store.get(key)),
    put: async (key, snapshot) => {
      validateSnapshot(snapshot);
      if (snapshot.delta || snapshot.unchanged)
        throw new Error("IncompleteCacheSnapshot");
      return operation("readwrite", (store) => store.put(snapshot, key));
    },
    remove: (key) => operation("readwrite", (store) => store.delete(key)),
    close: () => db.close(),
  };
}
