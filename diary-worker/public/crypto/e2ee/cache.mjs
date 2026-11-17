import { validateSnapshot } from './record.mjs';
import { validateEnvelope } from './crypto.mjs';

export const CIPHER_CACHE_LIMIT = 50_000_000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const stableKey = key => typeof key === 'string' ? key.replace(/\/[0-9]+$/, '') : key;

// One budget across all accounts, households and generations on this origin.
// Eviction never removes the separate, monotonic rollback checkpoints.
export async function openCipherCache(name = 'tlain-diary-encrypted-v1', {limitBytes = CIPHER_CACHE_LIMIT} = {}) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > CIPHER_CACHE_LIMIT) throw new Error('InvalidCacheLimit');
  const request = indexedDB.open(name, 4);
  request.onupgradeneeded = () => {
    const db = request.result, tx = request.transaction;
    for (const store of ['snapshots', 'checkpoints', 'usage', 'indexes'])
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    const entries = [], read = tx.objectStore('snapshots').openCursor();
    read.onsuccess = () => {
      const cursor = read.result;
      if (!cursor) {
        let total = entries.reduce((n, row) => n + row.bytes, 0);
        for (const row of entries) if (total > limitBytes) {
          tx.objectStore('snapshots').delete(row.key);tx.objectStore('indexes').delete(row.key);tx.objectStore('usage').delete(row.key);total -= row.bytes;
        }
        return;
      }
      try {
        validateSnapshot(cursor.value);
        if (cursor.value.delta || cursor.value.unchanged) throw new Error('IncompleteCacheSnapshot');
        const row = {key:cursor.key,bytes:bytes(cursor.value),lastUsed:0}, sequence = cursor.value.sequence;entries.push(row);
        tx.objectStore('usage').put(row, cursor.key);
        const points = tx.objectStore('checkpoints'), key = stableKey(cursor.key), previous = points.get(key);
        previous.onsuccess = () => points.put(Math.max(previous.result || 0, sequence), key);
      } catch {cursor.delete();tx.objectStore('indexes').delete(cursor.key);tx.objectStore('usage').delete(cursor.key);}
      cursor.continue();
    };
  };
  let abandoned=false;
  const db = await new Promise((resolve, reject) => {
    // An older open tab may still hold the v2 database. Use the online path
    // immediately instead of blocking login until that tab is closed.
    request.onblocked = () => {abandoned=true;reject(new Error('CacheUnavailable'));};
    request.onsuccess = () => {if(abandoned){request.result.close();return;}resolve(request.result);};
    request.onerror = () => reject(new Error('CacheUnavailable'));
  });
  db.onversionchange = () => db.close();
  const transaction = (stores, mode, run) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);let result, stale = false;
    const state = {set:value => {result = value;},rollback:() => {stale = true;tx.abort();}};
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error(stale ? 'CacheRollbackRejected' : 'CacheUnavailable'));
    run(tx, state);
  });
  return {
    get:key => transaction(['snapshots','usage'], 'readwrite', (tx, state) => {
      const read = tx.objectStore('snapshots').get(key);
      read.onsuccess = () => {
        state.set(read.result);
        if (read.result) {
          const previous=tx.objectStore('usage').get(key);
          previous.onsuccess=()=>tx.objectStore('usage').put({key,bytes:previous.result?.bytes??bytes(read.result),lastUsed:Date.now()},key);
        }
      };
    }),
    checkpoint:key => transaction(['checkpoints'], 'readonly', (tx, state) => {
      const read = tx.objectStore('checkpoints').get(key);read.onsuccess = () => state.set(read.result);
    }),
    put:async(key, snapshot, checkpointKey = stableKey(key)) => {
      validateSnapshot(snapshot);
      if (snapshot.delta || snapshot.unchanged) throw new Error('IncompleteCacheSnapshot');
      const size = bytes(snapshot);
      return transaction(['snapshots','checkpoints','usage','indexes'], 'readwrite', (tx, state) => {
        const snapshots = tx.objectStore('snapshots'), usage = tx.objectStore('usage'), points = tx.objectStore('checkpoints');
        const read = points.get(checkpointKey);
        read.onsuccess = () => {
          if (read.result > snapshot.sequence) return state.rollback();
          points.put(snapshot.sequence, checkpointKey);
          const all = usage.getAll();
          all.onsuccess = () => {
            const others = all.result.filter(row => {
              if (row.key === key || stableKey(row.key) === checkpointKey) {snapshots.delete(row.key);tx.objectStore('indexes').delete(row.key);usage.delete(row.key);return false;}
              return true;
            }).sort((a,b) => a.lastUsed - b.lastUsed);
            let total = others.reduce((n,row) => n + row.bytes, 0) + (size <= limitBytes ? size : 0);
            for (const row of others) if (total > limitBytes) {snapshots.delete(row.key);tx.objectStore('indexes').delete(row.key);usage.delete(row.key);total -= row.bytes;}
            if (size <= limitBytes) {snapshots.put(snapshot, key);usage.put({key,bytes:size,lastUsed:Date.now()}, key);}
          };
        };
      });
    },
    getIndex:key => transaction(['indexes'],'readonly',(tx,state)=>{
      const read=tx.objectStore('indexes').get(key);read.onsuccess=()=>state.set(read.result);
    }),
    putIndex:(key,sequence,envelope) => {
      if(!Number.isSafeInteger(sequence)||sequence<0)throw new Error('InvalidCacheIndex');
      validateEnvelope(envelope);
      return transaction(['snapshots','indexes','usage'],'readwrite',(tx,state)=>{
        const snapshots=tx.objectStore('snapshots'),indexes=tx.objectStore('indexes'),usage=tx.objectStore('usage');
        const read=snapshots.get(key);
        read.onsuccess=()=>{
          // A late task must not attach an old index after another tab updates
          // or evicts its snapshot. Both stores use one shared byte budget.
          if(!read.result||read.result.sequence!==sequence)return;
          const packet={sequence,envelope},size=bytes(read.result)+bytes(packet);
          if(size>limitBytes)return;
          const all=usage.getAll();
          all.onsuccess=()=>{
            const others=all.result.filter(row=>row.key!==key).sort((a,b)=>a.lastUsed-b.lastUsed);
            let total=size+others.reduce((n,row)=>n+row.bytes,0);
            for(const row of others)if(total>limitBytes){snapshots.delete(row.key);indexes.delete(row.key);usage.delete(row.key);total-=row.bytes;}
            indexes.put(packet,key);usage.put({key,bytes:size,lastUsed:Date.now()},key);state.set(true);
          };
        };
      });
    },
    remove:key => transaction(['snapshots','usage','indexes'], 'readwrite', tx => {tx.objectStore('snapshots').delete(key);tx.objectStore('indexes').delete(key);tx.objectStore('usage').delete(key);}),
    usage:() => transaction(['usage'], 'readonly', (tx, state) => {
      const read = tx.objectStore('usage').getAll();read.onsuccess = () => state.set({bytes:read.result.reduce((n,row) => n + row.bytes, 0),count:read.result.length,limitBytes});
    }),
    close:() => db.close(),
  };
}
