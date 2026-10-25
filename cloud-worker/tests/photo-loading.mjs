import assert from 'node:assert/strict';

globalThis.window = globalThis;
await import('../public/crypto-vault.js');
await import('../public/media-range.js');
await import('../public/media-client.js');
const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const source = crypto.getRandomValues(new Uint8Array(4096));
const encrypted = await TRoomCrypto.encryptFileChunk(key, source, 0);
const file = {id:1,sizeBytes:source.length,chunkSizeBytes:8192,chunkCount:1,mimeType:'image/png',offlineStorageId:'synthetic-photo'};
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
const until = async condition => {
  const deadline=Date.now()+2000;
  while(!condition()) { assert.ok(Date.now()<deadline,'photo loading did not reach its expected boundary'); await new Promise(r=>setTimeout(r,5)); }
};
const originals = {fetch,crypto:TRoomCrypto};
let fetches=0,writes=0;
globalThis.TCloudSession={check(){}};
globalThis.TCloudOffline={supported:()=>true,getChunk:async()=>null,putChunk:async(_id,_index,bytes)=>{
  assert.deepEqual(new Uint8Array(bytes),encrypted,'only the encrypted envelope reaches device storage'); writes++;
}};
globalThis.fetch=async(_url,options)=>{fetches++;assert.equal(options.headers.Range,`bytes=0-${encrypted.length-1}`);return new Response(encrypted,{status:206});};
try {
  const cacheReady=deferred();
  const blob=await TCloudMedia.decryptToBlob(file,key,'/synthetic-photo',{cacheReady:cacheReady.promise});
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),source);
  assert.equal(fetches,1);
  assert.equal(writes,0,'a transfer must not write before the cache entry is ready');
  cacheReady.resolve(); await until(()=>writes===1);

  // Closing while cache preparation is pending must drop the later write.
  writes=0;
  const pendingCache=deferred(),lateWrite=new AbortController();
  await TCloudMedia.decryptToBlob(file,key,'/synthetic-photo',{cacheReady:pendingCache.promise,signal:lateWrite.signal});
  lateWrite.abort(); pendingCache.resolve(); await new Promise(r=>setTimeout(r,10));
  assert.equal(writes,0);

  let cacheRead=false,decrypts=0;
  const cached=deferred(),cancelCached=new AbortController();
  globalThis.TCloudOffline={...TCloudOffline,getChunk:async()=>{cacheRead=true;return cached.promise;}};
  globalThis.TRoomCrypto={...originals.crypto,decryptFileChunk:async(...args)=>{decrypts++;return originals.crypto.decryptFileChunk(...args);}};
  const cachedLoad=TCloudMedia.decryptToBlob(file,key,'/synthetic-photo',{signal:cancelCached.signal});
  const cachedRejected=assert.rejects(cachedLoad,{name:'AbortError'});
  await until(()=>cacheRead); cancelCached.abort(); cached.resolve(encrypted);
  await cachedRejected;
  assert.equal(decrypts,0,'cancelled cache reads must not start WebCrypto');
  assert.equal(fetches,2);

  globalThis.TCloudOffline={...TCloudOffline,getChunk:async()=>null};
  const cryptoGate=deferred(),cancelCrypto=new AbortController(); let cryptoStarted=false,progress=0;
  globalThis.TRoomCrypto={...originals.crypto,decryptFileChunk:async(...args)=>{
    cryptoStarted=true;const result=originals.crypto.decryptFileChunk(...args);await cryptoGate.promise;return result;
  }};
  const cryptoLoad=TCloudMedia.decryptToBlob(file,key,'/synthetic-photo',{signal:cancelCrypto.signal,onProgress:()=>progress++});
  const cryptoRejected=assert.rejects(cryptoLoad,{name:'AbortError'});
  await until(()=>cryptoStarted);cancelCrypto.abort();cryptoGate.resolve();await cryptoRejected;
  assert.equal(progress,0,'native crypto already in progress may finish, but its stale result is discarded');

  globalThis.TRoomCrypto=originals.crypto;
  let abortedFetches=0,activeFetches=0;
  globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{
    activeFetches++;
    signal.addEventListener('abort',()=>{abortedFetches++;reject(new DOMException('cancelled','AbortError'));},{once:true});
  });
  const cancelFetch=new AbortController();
  const networkLoad=TCloudMedia.decryptToBlob({...file,chunkCount:8,sizeBytes:8*8192},key,'/synthetic-photo',{signal:cancelFetch.signal});
  const networkRejected=assert.rejects(networkLoad,{name:'AbortError'});
  await until(()=>activeFetches===2);cancelFetch.abort();await networkRejected;
  assert.equal(abortedFetches,2,'both active Range fetches use the preview cancellation signal');
  console.log('PASS photo loading: cache preparation overlaps transfer, encrypted writes wait, stale fetch/cache/crypto work stops');
} finally {globalThis.fetch=originals.fetch;globalThis.TRoomCrypto=originals.crypto;}
