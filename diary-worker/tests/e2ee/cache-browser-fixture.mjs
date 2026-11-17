import assert from 'node:assert/strict';

export async function verifyCacheBudget(page) {
  const result=await page.evaluate(async()=>{
    const {openCipherCache,CIPHER_CACHE_LIMIT}=await import('/diary/crypto/e2ee/cache.mjs');
    const snapshot=(sequence=1,household='A')=>({version:1,household,sequence,baseSequence:-1,delta:false,unchanged:false,records:[],removed:[]});
    const size=new TextEncoder().encode(JSON.stringify(snapshot())).length,name='budget-fixture-'+crypto.randomUUID(),limitBytes=size*2+1;
    const a=await openCipherCache(name,{limitBytes}),b=await openCipherCache(name,{limitBytes});
    const pause=()=>new Promise(r=>setTimeout(r,5));
    try {
      await a.put('a/key/A/1',snapshot(),'a/key/A');await pause();
      await a.put('b/key/A/1',snapshot(),'b/key/A');await pause();
      await a.get('a/key/A/1');await pause();
      await b.put('c/key/A/1',snapshot(),'c/key/A');
      const lru=Boolean(await a.get('a/key/A/1'))&&!await a.get('b/key/A/1')&&Boolean(await a.get('c/key/A/1'));
      const point=await a.checkpoint('b/key/A');
      await a.put('a/key/A/2',snapshot(2),'a/key/A');
      const oldGeneration=await a.get('a/key/A/1');
      await Promise.all([a.put('d/key/A/1',snapshot(),'d/key/A'),b.put('e/key/A/1',snapshot(),'e/key/A')]);
      const usage=await a.usage();let rollback=false;
      try{await a.put('a/key/A/2',snapshot(1),'a/key/A');}catch(error){rollback=error.message==='CacheRollbackRejected';}
      const tiny=await openCipherCache(name+'-tiny',{limitBytes:size});
      await tiny.put('huge/key/A/1',snapshot(9,'A'.repeat(160)),'huge/key/A');
      const oversized={usage:await tiny.usage(),checkpoint:await tiny.checkpoint('huge/key/A')};tiny.close();
      // Upgrade an existing v2 cache and prune it in the upgrade transaction.
      const legacyName=name+'-old';
      await new Promise((resolve,reject)=>{const req=indexedDB.open(legacyName,2);req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('snapshots');db.createObjectStore('checkpoints');};req.onerror=reject;req.onsuccess=()=>{const db=req.result,tx=db.transaction(['snapshots','checkpoints'],'readwrite');for(const key of ['a','b','c']){tx.objectStore('snapshots').put(snapshot(),key+'/key/A/1');tx.objectStore('checkpoints').put(7,key+'/key/A');}tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};});
      const upgraded=await openCipherCache(legacyName,{limitBytes}),upgrade={usage:await upgraded.usage(),point:await upgraded.checkpoint('a/key/A')};upgraded.close();
      const blockedName=name+'-blocked',old=await new Promise((resolve,reject)=>{const req=indexedDB.open(blockedName,2);req.onupgradeneeded=()=>{req.result.createObjectStore('snapshots');req.result.createObjectStore('checkpoints');};req.onsuccess=()=>resolve(req.result);req.onerror=reject;});
      let blockedFallback=false,timer;
      try{await Promise.race([openCipherCache(blockedName),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('BlockedUpgradeWaited')),2000);})]);}
      catch(error){blockedFallback=error.message==='CacheUnavailable';}
      finally{clearTimeout(timer);old.close();}
      const recovered=await openCipherCache(blockedName);recovered.close();
      const indexed=await openCipherCache(name+'-indexes',{limitBytes:size*3});
      const box={version:1,iv:'AAAAAAAAAAAAAAAA',ciphertext:'AAAAAAAAAAAAAAAAAAAAAA'};
      await indexed.put('a/key/A/1',snapshot(),'a/key/A');await indexed.putIndex('a/key/A/1',1,box);
      const withIndex=await indexed.usage();await indexed.get('a/key/A/1');const afterRead=await indexed.usage();
      await pause();await indexed.put('b/key/A/1',snapshot(),'b/key/A');await pause();await indexed.put('c/key/A/1',snapshot(),'c/key/A');
      const evictedIndex=await indexed.getIndex('a/key/A/1'),retainedPoint=await indexed.checkpoint('a/key/A');
      await indexed.put('c/key/A/1',snapshot(2),'c/key/A');await indexed.putIndex('c/key/A/1',1,box);
      const lateIndex=await indexed.getIndex('c/key/A/1');let rejectsPlaintext=false;
      try{await indexed.putIndex('c/key/A/1',2,{summary:'PRIVATE_INDEX_TITLE'});}catch{rejectsPlaintext=true;}
      const indexBudget={baseSize:size,withIndex,afterRead,evictedIndex,retainedPoint,lateIndex,rejectsPlaintext,usage:await indexed.usage()};indexed.close();
      // Real users currently have v3: its snapshots/checkpoints must survive
      // the addition of the optional encrypted-index store.
      const v3Name=name+'-v3';
      await new Promise((resolve,reject)=>{const req=indexedDB.open(v3Name,3);req.onupgradeneeded=()=>{for(const store of ['snapshots','checkpoints','usage'])req.result.createObjectStore(store);};req.onerror=reject;req.onsuccess=()=>{const db=req.result,tx=db.transaction(['snapshots','checkpoints'],'readwrite');tx.objectStore('snapshots').put(snapshot(),'a/key/A/1');tx.objectStore('checkpoints').put(7,'a/key/A');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};});
      const v4=await openCipherCache(v3Name),v3Upgrade={snapshot:await v4.get('a/key/A/1'),point:await v4.checkpoint('a/key/A'),index:await v4.getIndex('a/key/A/1')};v4.close();
      return {lru,point,oldGeneration,usage,rollback,oversized,upgrade,blockedFallback,indexBudget,v3Upgrade,defaultLimit:CIPHER_CACHE_LIMIT};
    }finally{a.close();b.close();}
  });
  assert.equal(result.defaultLimit,50_000_000);assert.equal(result.lru,true);assert.equal(result.point,1);assert.equal(result.oldGeneration,undefined);
  assert.ok(result.usage.bytes<=result.usage.limitBytes);assert.ok(result.usage.count<=2);assert.equal(result.rollback,true);
  assert.equal(result.oversized.usage.bytes,0);assert.equal(result.oversized.checkpoint,9);assert.ok(result.upgrade.usage.bytes<=result.upgrade.usage.limitBytes);assert.equal(result.upgrade.point,7);
  assert.equal(result.blockedFallback,true,'an older open tab cannot stall login during a cache upgrade');
  assert.ok(result.indexBudget.withIndex.bytes>result.indexBudget.baseSize);assert.equal(result.indexBudget.withIndex.bytes,result.indexBudget.afterRead.bytes);
  assert.equal(result.indexBudget.evictedIndex,undefined);assert.equal(result.indexBudget.retainedPoint,1);assert.equal(result.indexBudget.lateIndex,undefined);
  assert.equal(result.indexBudget.rejectsPlaintext,true);assert.ok(result.indexBudget.usage.bytes<=result.indexBudget.usage.limitBytes);
  assert.equal(result.v3Upgrade.snapshot.sequence,1);assert.equal(result.v3Upgrade.point,7);assert.equal(result.v3Upgrade.index,undefined);
}

export async function waitForPreparedIndex(page) {
  await page.waitForFunction(async()=>new Promise((resolve,reject)=>{
    const req=indexedDB.open('tlain-diary-encrypted-v1');req.onerror=reject;
    req.onsuccess=()=>{
      const db=req.result;if(!db.objectStoreNames.contains('indexes')){db.close();resolve(false);return;}
      const tx=db.transaction(['snapshots','indexes']);let found=false;
      const cursor=tx.objectStore('snapshots').openCursor();
      cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;const index=tx.objectStore('indexes').get(row.key);index.onsuccess=()=>{if(index.result?.sequence===row.value.sequence)found=true;row.continue();};};
      tx.oncomplete=()=>{db.close();resolve(found);};tx.onerror=reject;
    };
  }));
}

export async function inspectLogoutStorage(page) {
  return page.evaluate(async()=>{
    const read=async(name,store)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onerror=reject;r.onsuccess=()=>{const db=r.result,tx=db.transaction(store),all=tx.objectStore(store).getAll();tx.oncomplete=()=>{db.close();resolve(all.result);};tx.onerror=reject;};});
    const keys=await read('tlain-diary-device-v1','keys'),cipher=await read('tlain-diary-encrypted-v1','snapshots'),indexes=await read('tlain-diary-encrypted-v1','indexes');
    return {keys:keys.length,cipherSnapshots:cipher.length,indexes:indexes.length,containsPlaintext:JSON.stringify([cipher,indexes]).includes('SYNTHETIC_PRIVATE_POST')};
  });
}
