import { validateSnapshot } from './record.mjs';
import { validateEnvelope } from './crypto.mjs';
import { photoHeader } from './photo-crypto.mjs';
import { validPhotoEtag } from './session.mjs';

export const CIPHER_CACHE_LIMIT = 50_000_000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const stableKey = key => typeof key === 'string' ? key.replace(/\/[0-9]+$/, '') : key;

// One budget across all accounts, households and generations on this origin.
// Eviction never removes the separate, monotonic rollback checkpoints.
export async function openCipherCache(name = 'tlain-diary-encrypted-v1', {limitBytes = CIPHER_CACHE_LIMIT, openTimeoutMs = 0} = {}) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > CIPHER_CACHE_LIMIT) throw new Error('InvalidCacheLimit');
  const request = indexedDB.open(name, 4);
  let abandoned=false, timer;
  request.onupgradeneeded = () => {
    if (abandoned) {
      request.transaction.abort();
      return;
    }
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
        const size=bytes(cursor.value),sequence=cursor.value.sequence;
        const row={key:cursor.key,bytes:size,snapshotBytes:size,sequence,lastUsed:0};entries.push(row);
        tx.objectStore('usage').put(row, cursor.key);
        const points = tx.objectStore('checkpoints'), key = stableKey(cursor.key), previous = points.get(key);
        previous.onsuccess = () => points.put(Math.max(previous.result || 0, sequence), key);
      } catch {cursor.delete();tx.objectStore('indexes').delete(cursor.key);tx.objectStore('usage').delete(cursor.key);}
      cursor.continue();
    };
  };
  const db = await new Promise((resolve, reject) => {
    // An older open tab may still hold the v2 database. Use the online path
    // immediately instead of blocking login until that tab is closed.
    const unavailable = () => {abandoned=true;reject(new Error('CacheUnavailable'));};
    request.onblocked = unavailable;
    request.onsuccess = () => {if(abandoned){request.result.close();return;}resolve(request.result);};
    request.onerror = unavailable;
    if (openTimeoutMs) timer = setTimeout(unavailable, openTimeoutMs);
  }).finally(() => clearTimeout(timer));
  db.onversionchange = () => db.close();
  const transaction = (stores, mode, run) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);let result, stale = false;
    const state = {set:value => {result = value;},rollback:() => {stale = true;tx.abort();}};
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error(stale ? 'CacheRollbackRejected' : 'CacheUnavailable'));
    run(tx, state);
  });
  return {
    async readStartup(key, checkpointKey) {
      const values = await transaction(['snapshots','checkpoints','indexes'], 'readonly', (tx,state) => {
        const result = {};
        const requests = [
          ['snapshot',tx.objectStore('snapshots').get(key)],
          ['checkpoint',tx.objectStore('checkpoints').get(checkpointKey)],
          ['index',tx.objectStore('indexes').get(key)]
        ];
        for(const [field,request] of requests)request.onsuccess=()=>{result[field]=request.result;};
        state.set(result);
      });
      if(values.snapshot)void transaction(['usage'], 'readwrite', tx => {
        const usage=tx.objectStore('usage'),previous=usage.get(key);
        previous.onsuccess=()=>{if(previous.result)usage.put({...previous.result,lastUsed:Date.now()},key);};
      }).catch(()=>{});
      return values;
    },
    get:key => transaction(['snapshots','usage'], 'readwrite', (tx, state) => {
      const read = tx.objectStore('snapshots').get(key);
      read.onsuccess = () => {
        state.set(read.result);
        if (read.result) {
          const previous=tx.objectStore('usage').get(key);
          previous.onsuccess=()=>tx.objectStore('usage').put({
            ...(previous.result??{key,bytes:bytes(read.result)}),lastUsed:Date.now()
          },key);
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
            if (size <= limitBytes) {
              snapshots.put(snapshot,key);
              usage.put({key,bytes:size,snapshotBytes:size,sequence:snapshot.sequence,lastUsed:Date.now()},key);
            }
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
        const write=snapshotBytes=>{
          const packet={sequence,envelope},size=snapshotBytes+bytes(packet);
          if(size>limitBytes)return;
          const all=usage.getAll();
          all.onsuccess=()=>{
            const others=all.result.filter(row=>row.key!==key).sort((a,b)=>a.lastUsed-b.lastUsed);
            let total=size+others.reduce((n,row)=>n+row.bytes,0);
            for(const row of others)if(total>limitBytes){snapshots.delete(row.key);indexes.delete(row.key);usage.delete(row.key);total-=row.bytes;}
            indexes.put(packet,key);usage.put({key,bytes:size,snapshotBytes,sequence,lastUsed:Date.now()},key);state.set(true);
          };
        };
        const previous=usage.get(key);
        previous.onsuccess=()=>{
          // Usage and the snapshot advance in the same transaction. Metadata
          // avoids cloning and serializing the whole snapshot a second time.
          const summary=previous.result;
          if(!summary)return;
          if(Number.isSafeInteger(summary.snapshotBytes)&&summary.snapshotBytes>0) {
            if(summary.sequence===sequence)write(summary.snapshotBytes);
            return;
          }
          // Existing v4 browser data may have the earlier usage record.
          const read=snapshots.get(key);
          read.onsuccess=()=>{if(read.result?.sequence===sequence)write(bytes(read.result));};
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

const THUMBNAIL_CACHE_BYTES=32*1024*1024;
const THUMBNAIL_CACHE_COUNT=512;
export const MAX_THUMBNAIL_BYTES=1024*1024;
const totalsKey='totals';

export async function openThumbnailCache(name='tlain-diary-thumbnails-v1',{limitBytes=THUMBNAIL_CACHE_BYTES,limitCount=THUMBNAIL_CACHE_COUNT}={}) {
  if(!Number.isSafeInteger(limitBytes)||limitBytes<1||limitBytes>THUMBNAIL_CACHE_BYTES
    ||!Number.isSafeInteger(limitCount)||limitCount<1||limitCount>THUMBNAIL_CACHE_COUNT)throw new Error('InvalidThumbnailCacheLimit');
  const request=indexedDB.open(name,1);
  request.onupgradeneeded=()=>{
    request.result.createObjectStore('thumbnails');
    request.result.createObjectStore('usage').createIndex('access','access');
  };
  const db=await new Promise((resolve,reject)=>{
    let blocked=false;
    request.onblocked=()=>{blocked=true;reject(new Error('ThumbnailCacheUnavailable'));};
    request.onerror=()=>reject(new Error('ThumbnailCacheUnavailable'));
    request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};
  });
  db.onversionchange=()=>db.close();
  const transact=(stores,mode,run)=>new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,mode);
    let value;
    tx.oncomplete=()=>resolve(value);
    tx.onerror=tx.onabort=()=>reject(new Error('ThumbnailCacheUnavailable'));
    run(tx,result=>{value=result;});
  });
  return {
    get:key=>transact(['thumbnails'],'readonly',(tx,done)=>{
      const read=tx.objectStore('thumbnails').get(key);
      read.onsuccess=()=>done(read.result);
    }),
    async put(key,{etag,ciphertext,proof}) {
      if(!/^[\w-]{43}$/.test(key)||!validPhotoEtag(etag)||!(ciphertext instanceof ArrayBuffer)
        ||ciphertext.byteLength>MAX_THUMBNAIL_BYTES||!photoHeader(new Uint8Array(ciphertext)))return;
      validateEnvelope(proof);
      const size=ciphertext.byteLength+proof.ciphertext.length+etag.length+128;
      if(size>limitBytes)return;
      await transact(['thumbnails','usage'],'readwrite',tx=>{
        const thumbnails=tx.objectStore('thumbnails'),usage=tx.objectStore('usage');
        const existing=usage.get(key),readTotals=usage.get(totalsKey);
        readTotals.onsuccess=()=>{
          const totals=readTotals.result??{size:0,count:0,access:0};
          totals.size+=size-(existing.result?.size??0);
          if(!existing.result)totals.count++;
          const write=()=>{
            thumbnails.put({etag,ciphertext,proof},key);
            usage.put({etag,size,access:++totals.access},key);
            usage.put(totals,totalsKey);
          };
          if(totals.size<=limitBytes&&totals.count<=limitCount){write();return;}
          const query=usage.index('access').openCursor();
          query.onsuccess=()=>{
            const row=query.result;
            if(!row){tx.abort();return;}
            if(row.primaryKey!==key){
              thumbnails.delete(row.primaryKey);
              totals.size-=row.value.size;totals.count--;
              row.delete();
            }
            if(totals.size<=limitBytes&&totals.count<=limitCount)write();else row.continue();
          };
        };
      });
    },
    touch:(key,etag)=>transact(['usage'],'readwrite',tx=>{
      const usage=tx.objectStore('usage'),read=usage.get(key),readTotals=usage.get(totalsKey);
      readTotals.onsuccess=()=>{
        const current=read.result,totals=readTotals.result;
        if(current?.etag!==etag||!totals)return;
        current.access=++totals.access;
        usage.put(current,key);usage.put(totals,totalsKey);
      };
    }),
    close:()=>db.close()
  };
}
