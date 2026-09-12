import assert from 'node:assert/strict';
import {engines,root,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce');
const fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT || root);
try {
  for(const [name,engine,launch] of engines) {
    const browser=await engine.launch({headless:true,...launch});
    try {
      const page=await browser.newPage();await preparePage(page,fixture.origin,32);
      const bulk=await page.evaluate(async()=>{
        await TCloudDisplayCache.getThumbnail('bulk-a',0,'v1');
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('tcloud-display-cache');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const v2=db.version===2;
        await new Promise((resolve,reject)=>{
          const t=db.transaction([...db.objectStoreNames],'readwrite');t.oncomplete=resolve;t.onerror=()=>reject(t.error);
          const payload=new ArrayBuffer(32*1024);
          for(let i=0;i<1000;i++) {
            const scope=i%2?'bulk-b':'bulk-a',id=v2?[scope,'thumbnail',`${i}:v1`]:`thumbnail:${scope}:${i}:v1`;
            const metadata={id,scope,kind:'thumbnail',fileId:i,cacheKey:`${i}:v1`,sizeBytes:payload.byteLength,lastAccessed:i};
            t.objectStore('entries').put(v2?{id,payload,mimeType:'image/png'}:{...metadata,payload,mimeType:'image/png'});
            if(v2)t.objectStore('metadata').put(metadata);
          }
          if(v2)t.objectStore('totals').put({kind:'thumbnail',count:1000,bytes:payload.byteLength*1000});
        });
        const operations={payloadReads:0,payloadWrites:0,getAll:0};
        for(const method of ['get','getAll','openCursor','put']) {
          const original=IDBObjectStore.prototype[method];
          IDBObjectStore.prototype[method]=function(...args){
            if(this.name==='entries') {if(method==='put')operations.payloadWrites++;else operations.payloadReads++;}
            if(method==='getAll'&&this.name==='entries')operations.getAll++;
            return original.apply(this,args);
          };
        }
        let frames=0,alive=true;const pulse=()=>{if(alive){frames++;requestAnimationFrame(pulse);}};requestAnimationFrame(pulse);
        const started=performance.now(),timings={};
        const summary=await TCloudDisplayCache.summary('bulk-a');
        timings.summary=performance.now()-started;
        const summaryOps={...operations};
        const hit=await TCloudDisplayCache.getThumbnail('bulk-a',0,'v1');
        await new Promise(r=>setTimeout(r,20));
        const touchOps={...operations};
        const maintenanceStart=performance.now();
        await TCloudDisplayCache.removeFile('bulk-a',4);
        await TCloudDisplayCache.putThumbnail('bulk-a',2,'v2',new Blob(['new-thumbnail']));
        const oldVersion=await TCloudDisplayCache.getThumbnail('bulk-a',2,'v1');
        timings.maintenance=performance.now()-maintenanceStart;
        const clearStart=performance.now();
        await TCloudDisplayCache.clearScope('bulk-b');
        timings.clear=performance.now()-clearStart;
        const remaining=await TCloudDisplayCache.summary();
        alive=false;
        db.close();
        return {summary,summaryOps,touchOps,operations,remaining,hitBytes:hit.size,oldVersion:!!oldVersion,elapsed:Math.round(performance.now()-started),frames,timings};
      });
      assert.equal(bulk.summary.thumbnailCount,500);assert.equal(bulk.hitBytes,32768);assert.equal(bulk.oldVersion,false);assert.equal(bulk.remaining.thumbnailCount,499);
      if(!before) {assert.equal(bulk.summaryOps.payloadReads,0);assert.equal(bulk.touchOps.payloadWrites,0);assert.equal(bulk.operations.getAll,0);}
      console.log(before?'BEFORE cache':'PASS cache',name,JSON.stringify(bulk));
      if(!before) {
        const scopes=await page.evaluate(async()=>{
          const base={role:'member',serviceAccountId:'folder-member',serviceLinkId:'link-a',rootFolderId:7,sessionCacheId:'session-a'};
          const results=[];
          for(const role of ['member','admin','subadmin']) {
            const initial={...base,role,serviceAccountId:role==='member'?'folder-member':role};
            __test.state.session=initial;const scope=__test.displayCacheScope();
            await TCloudDisplayCache.putThumbnail(scope,1,'scope',__thumb.blob);
            for(const change of [{serviceLinkId:'link-b'},{rootFolderId:8},{sessionCacheId:'session-b'},{serviceAccountId:'different'},{role:role==='admin'?'subadmin':'admin'}]) {
              __test.state.session={...initial,...change};const next=__test.displayCacheScope();
              results.push(scope!==next&&!await TCloudDisplayCache.getThumbnail(next,1,'scope'));
            }
          }
          __test.releaseSessionState();results.push(__test.displayCacheScope()===''&&document.querySelector('#content-grid').children.length===0&&__test.state.thumbnailLoadTasks.size===0);
          return results;
        });assert.ok(scopes.every(Boolean));
        // Atomic replacement of concurrent versions: retain one complete pair, never delete both.
        const concurrent=await page.evaluate(async()=>{
          await Promise.all(['a','b'].map(v=>TCloudDisplayCache.putThumbnail('concurrent',1,v,new Blob([v]))));
          const a=await TCloudDisplayCache.getThumbnail('concurrent',1,'a'),b=await TCloudDisplayCache.getThumbnail('concurrent',1,'b');
          return {count:Number(!!a)+Number(!!b),summary:await TCloudDisplayCache.summary('concurrent')};
        });assert.equal(concurrent.count,1);assert.equal(concurrent.summary.thumbnailCount,1);
        const eviction=await page.evaluate(async()=>{
          const db=await new Promise(r=>{const request=indexedDB.open('tcloud-display-cache');request.onsuccess=()=>r(request.result);});
          // Logical sizes exercise LRU without allocating gigabytes on the test device.
          await new Promise((resolve,reject)=>{const t=db.transaction(['entries','metadata','totals'],'readwrite');
            t.objectStore('entries').clear();t.objectStore('metadata').clear();t.objectStore('totals').clear();
            for(let i=0;i<4;i++){const id=['lru','thumbnail',`${i}:v1`];t.objectStore('entries').put({id,payload:new ArrayBuffer(1)});t.objectStore('metadata').put({id,kind:'thumbnail',scope:'lru',cacheKey:`${i}:v1`,fileId:i,sizeBytes:400*1024*1024,lastAccessed:i});}
            t.objectStore('totals').put({kind:'thumbnail',bytes:1600*1024*1024,count:4});t.oncomplete=resolve;t.onerror=()=>reject(t.error);
          });
          await TCloudDisplayCache.getThumbnail('lru',0,'v1');
          await new Promise(r=>setTimeout(r,20));
          await TCloudDisplayCache.putThumbnail('lru',4,'v1',new Blob(['new']));
          const present=[];for(let i=0;i<5;i++)present.push(!!await TCloudDisplayCache.getThumbnail('lru',i,'v1'));
          const summary=await TCloudDisplayCache.summary('lru');db.close();return {present,summary};
        });assert.deepEqual(eviction.present,[true,false,false,true,true]);assert.equal(eviction.summary.thumbnailCount,3);assert.ok(eviction.summary.thumbnailBytes<=1024*1024*1024);
      }
      await page.close();
      if(!before) {
        const context=await browser.newContext(),migration=await context.newPage();
        await migration.goto(fixture.origin+'/empty');
        await migration.evaluate(async()=>{
          for(const [name,store] of [['tcloud-display-cache','entries'],['tcloud-device-vault','crypto-keys'],['tcloud-offline-fixture','chunks']]) {
            const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore(store,{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
            await new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');t.objectStore(store).put({id:'preserve',payload:new Uint8Array([1,2,3])});t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
          }
        });
        await preparePage(migration,fixture.origin,1);
        const preserved=await migration.evaluate(async()=>{
          await TCloudDisplayCache.putThumbnail('new',1,'v2',__thumb.blob);
          const values=[];
          for(const [name,store] of [['tcloud-device-vault','crypto-keys'],['tcloud-offline-fixture','chunks']]) {
            const db=await new Promise(r=>{const request=indexedDB.open(name);request.onsuccess=()=>r(request.result);});
            const entry=await new Promise(r=>{const request=db.transaction(store).objectStore(store).get('preserve');request.onsuccess=()=>r(request.result);});db.close();values.push([...entry.payload]);
          }
          return {values,summary:await TCloudDisplayCache.summary()};
        });assert.deepEqual(preserved.values,[[1,2,3],[1,2,3]]);assert.equal(preserved.summary.thumbnailCount,1);
        await context.close();
        console.log('PASS v1 cache-only rebuild, scopes, logout, concurrent versions',name);
      }
    } finally {await browser.close();}
  }
} finally {await fixture.close();}
