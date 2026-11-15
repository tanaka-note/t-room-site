import { validateSnapshot } from "./record.mjs";
// This candidate persists ciphertext only, never PRF, CryptoKeys or plaintext.
// It must run on the dedicated diary origin before production use.
export async function openCipherCache(name = "tlain-diary-encrypted-v1") {
  const request = indexedDB.open(name, 2);
  request.onupgradeneeded = () => {
    for (const store of ["snapshots", "checkpoints"])
      if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
    const tx=request.transaction,read=tx.objectStore("snapshots").openCursor();
    read.onsuccess=()=>{const cursor=read.result;if(!cursor)return;
      try{
        validateSnapshot(cursor.value);
        const points=tx.objectStore("checkpoints"),stable=typeof cursor.key==='string'?cursor.key.replace(/\/[0-9]+$/,''):cursor.key;
        const previous=points.get(stable);previous.onsuccess=()=>{points.put(Math.max(previous.result||0,cursor.value.sequence),stable);cursor.continue();};
      }catch{/* Invalid old snapshots are never trusted. */cursor.continue();}};
  };
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("CacheUnavailable"));
  });
  const operation = (mode, callback, name = "snapshots") =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = callback(tx.objectStore(name));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(new Error("CacheUnavailable"));
    });
  return {
    get: (key) => operation("readonly", (store) => store.get(key)),
    checkpoint: (key) => operation("readonly", store => store.get(key), "checkpoints"),
    put: async (key, snapshot, checkpointKey=key) => {
      validateSnapshot(snapshot);
      if (snapshot.delta || snapshot.unchanged)
        throw new Error("IncompleteCacheSnapshot");
      return new Promise((resolve,reject)=>{
        const tx=db.transaction(['snapshots','checkpoints'],'readwrite'),store=tx.objectStore('snapshots'),points=tx.objectStore('checkpoints'),read=points.get(checkpointKey);let stale=false;
        read.onsuccess=()=>{if(read.result>snapshot.sequence){stale=true;tx.abort();return;}store.put(snapshot,key);points.put(snapshot.sequence,checkpointKey);};
        tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error(stale?'CacheRollbackRejected':'CacheUnavailable'));
      });
    },
    remove: (key) => operation("readwrite", (store) => store.delete(key)),
    close: () => db.close(),
  };
}
