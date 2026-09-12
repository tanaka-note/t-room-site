import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {engines, root, startUIFixture, preparePage} from './ui-fixture.mjs';

const before=process.argv.includes('--reproduce');
const perfOnly=process.argv.includes('--perf-only');
const fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT || root);
const results=[];
try {
  for (const [name,engine,launch] of engines) {
    const browser=await engine.launch({headless:true,...launch});
    try {
      for (const count of [32,128]) for (const cached of [false,true]) for(let repeat=0;repeat<(perfOnly?3:1);repeat++) {
        const page=await browser.newPage({viewport:{width:390,height:740}});
        try {
          await preparePage(page,fixture.origin,count);
          const encrypted=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await __thumb.encrypted.arrayBuffer()))));
          const requests=[];
          await page.route('**/cloud/api/**',async route=>{
            requests.push({method:route.request().method(),body:route.request().postData(),url:route.request().url()});
            await new Promise(r=>setTimeout(r,25));
            await route.fulfill({body:encrypted,contentType:'application/octet-stream'});
          });
          if(cached) await page.evaluate(async()=>{const scope=__test.displayCacheScope();for(const file of __test.state.files)await TCloudDisplayCache.putThumbnail(scope,file.id,file.createdAt,__thumb.blob);});
          await page.evaluate(()=>{
            globalThis.__idb={getAll:0,payloadWrites:0};
            const getAll=IDBObjectStore.prototype.getAll,put=IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.getAll=function(...args){__idb.getAll++;return getAll.apply(this,args);};
            IDBObjectStore.prototype.put=function(value,...args){if(value.payload)__idb.payloadWrites++;return put.call(this,value,...args);};
            globalThis.__visible=[...document.querySelectorAll('.thumb')].filter(el=>{const r=el.getBoundingClientRect();return r.top<document.querySelector('.workspace').getBoundingClientRect().bottom&&r.bottom>0;});
            globalThis.__readyAt=0;
            const observer=new MutationObserver(()=>{if(__visible.every(el=>el.querySelector('img')?.naturalWidth>0)){__readyAt=performance.now();observer.disconnect();}});
            observer.observe(document.querySelector('#content-grid'),{childList:true,subtree:true});
            globalThis.__started=performance.now();__test.scheduleEncryptedThumbnailLoading();
          });
          await page.waitForFunction(()=>__readyAt>0);
          const measured=await page.evaluate(()=>({elapsed:Math.round(__readyAt-__started),visible:__visible.length,...__idb}));
          assert.ok(requests.every(r=>r.method==='GET'&&!r.body),'no local plaintext/key upload');
          if(cached)assert.equal(requests.length,0);
          results.push({name,count,cached,repeat,...measured});
        } finally {await page.close();}
      }
      if(perfOnly)continue;
      if(before) {
        const page=await browser.newPage({viewport:{width:390,height:740}});
        await preparePage(page,fixture.origin,128);
        let attempts=0;
        await page.route('**/cloud/api/**',route=>{attempts++;return route.fulfill({status:503,body:''});});
        await page.evaluate(()=>{__test.state.files=__test.state.files.slice(0,1);__test.scheduleEncryptedThumbnailLoading();});
        await page.waitForFunction(()=>__test.state.thumbnailLoadActive===0&&__test.state.thumbnailLoadQueuedIds.size>0);
        const stuck=await page.evaluate(()=>({queued:__test.state.thumbnailLoadQueuedIds.size,icon:!!document.querySelector('.thumb svg')}));
        assert.equal(stuck.queued,1);assert.equal(stuck.icon,true);
        console.log('REPRODUCED queue entry remains after transient failures',name,{attempts,...stuck});
        await page.close();
      } else {
        for(const scenario of ['cold','warm','corrupt','500','429','408','network','503-limit','401','403','419','wrong-key','no-key','invalid-envelope','decode']) {
          const page=await browser.newPage({viewport:{width:390,height:740}});
          try {
            await preparePage(page,fixture.origin,32);
            const encrypted=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await __thumb.encrypted.arrayBuffer()))));
            const invalidImage=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await (await TRoomCrypto.encryptThumbnail(new Blob(['invalid-image']),__thumb.key)).arrayBuffer()))));
            const calls=[];
            await page.route('**/cloud/api/**',async route=>{
              assert.equal(route.request().method(),'GET');assert.equal(route.request().postData(),null);
              calls.push(Date.now());
              if(scenario==='network'&&calls.length===1)return route.abort();
              const status=['401','403','419'].includes(scenario)?Number(scenario):scenario==='503-limit'?503:
                ['500','429','408'].includes(scenario)&&calls.length===1?Number(scenario):200;
              return route.fulfill({status,body:scenario==='invalid-envelope'?Buffer.from('invalid'):scenario==='decode'?invalidImage:encrypted});
            });
            await page.evaluate(async scenario=>{
              __test.state.files=__test.state.files.slice(0,1);
              const file=__test.state.files[0],scope=__test.displayCacheScope();
              if(scenario==='warm'||scenario==='corrupt') await TCloudDisplayCache.putThumbnail(scope,file.id,file.createdAt,scenario==='warm'?__thumb.blob:new Blob(['bad']));
              if(scenario==='no-key')file.fileKey=null;
              if(scenario==='wrong-key')file.fileKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
              globalThis.TCLOUD_THUMBNAIL_DEBUG=true;__test.scheduleEncryptedThumbnailLoading();
            },scenario);
            await page.waitForFunction(()=>['done','stopped'].includes(__test.state.thumbnailLoadTasks.get(1)?.status)&&__test.state.thumbnailLoadActive===0);
            const actual=await page.evaluate(()=>{const stage=document.querySelector('.file-card[data-file-id="1"] .thumb');return {image:!!stage.querySelector('img'),icon:!!stage.querySelector('svg'),queued:__test.state.thumbnailLoadQueuedIds.size,timings:TCloudUI.thumbnailTimings().map(t=>t.step)};});
            const success=['cold','warm','corrupt','500','429','408','network'].includes(scenario);
            assert.equal(actual.image,success,scenario);assert.equal(actual.icon,!success,scenario);assert.equal(actual.queued,0,scenario);
            const expected=['warm','no-key'].includes(scenario)?0:scenario==='503-limit'?3:['500','429','408','network'].includes(scenario)?2:1;
            assert.equal(calls.length,expected,scenario);
            if(calls.length>1)assert.ok(calls[1]-calls[0]>=490,'first backoff');
            if(calls.length>2)assert.ok(calls[2]-calls[1]>=1990,'second backoff');
            // Observer/scroll/schedule events must not reset the retry budget or sticky permanent result.
            await page.evaluate(()=>{__test.scheduleEncryptedThumbnailLoading();__test.scrollAppTo({top:20});});
            await page.waitForTimeout(100);assert.equal(calls.length,expected,scenario);
            if(scenario==='cold')for(const step of ['cache-read','fetch','decrypt','decode','dom'])assert.ok(actual.timings.includes(step),step);
          } finally {await page.close();}
        }
        console.log('PASS thumbnail cache, bounded retries, key/permission/decode stops',name);
        // Hold the original four requests, scroll far away, then release them. Newly visible
        // cards must precede the existing background queue without exceeding four active jobs.
        const page=await browser.newPage({viewport:{width:390,height:740}});
        await preparePage(page,fixture.origin,128);
        const encrypted=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await __thumb.encrypted.arrayBuffer()))));
        const started=[],held=[];let active=0,maxActive=0;
        await page.route('**/cloud/api/**',async route=>{
          const id=Number(route.request().url().match(/files\/(\d+)/)?.[1]);
          started.push(id);active++;maxActive=Math.max(maxActive,active);
          if(started.length<=4)await new Promise(r=>held.push(r));
          await route.fulfill({body:encrypted});active--;
        });
        await page.evaluate(()=>__test.scheduleEncryptedThumbnailLoading());
        while(held.length<4)await page.waitForTimeout(10);
        const visible=await page.evaluate(()=>{
          __test.scrollAppTo({top:6500,left:0,behavior:'auto'});
          const bottom=document.querySelector('.workspace').getBoundingClientRect().bottom;
          return [...document.querySelectorAll('.file-card')].filter(e=>{const r=e.getBoundingClientRect();return r.top<bottom&&r.bottom>0;}).map(e=>Number(e.dataset.fileId));
        });
        held.forEach(r=>r());
        await page.waitForFunction(ids=>ids.every(id=>document.querySelector(`.file-card[data-file-id="${id}"] img`)),visible);
        assert.ok(started.slice(4,4+visible.length).every(id=>visible.includes(id)),JSON.stringify({started:started.slice(0,12),visible}));
        assert.ok(maxActive<=4);
        await page.close();
        console.log('PASS viewport reprioritization and four-worker limit',name);
        for(const change of ['scope','logout']) {
          const page=await browser.newPage({viewport:{width:390,height:740}});
          await preparePage(page,fixture.origin,32);
          const encrypted=Buffer.from(await page.evaluate(async()=>Array.from(new Uint8Array(await __thumb.encrypted.arrayBuffer()))));
          let pending;
          await page.route('**/cloud/api/**',async route=>{pending=route;});
          const originalScope=await page.evaluate(()=>{
            __test.state.files=__test.state.files.slice(0,1);__test.scheduleEncryptedThumbnailLoading();
            __test.scheduleDisplayListingCacheWrite('delayed');return __test.displayCacheScope();
          });
          while(!pending)await page.waitForTimeout(10);
          await page.evaluate(change=>{
            if(change==='logout')__test.releaseSessionState();
            else __test.state.session={...__test.state.session,sessionCacheId:'new-session',serviceLinkId:'new-link'};
          },change);
          await pending.fulfill({body:encrypted}).catch(()=>{});
          await page.waitForTimeout(200);
          const stale=await page.evaluate(async originalScope=>({images:document.querySelectorAll('.thumb img').length,
            thumbnail:!!await TCloudDisplayCache.getThumbnail(originalScope,1,'2026-09-12 00:00:00'),listing:!!await TCloudDisplayCache.getListing(originalScope,'delayed')}),originalScope);
          assert.deepEqual(stale,{images:0,thumbnail:false,listing:false},change);
          await page.close();
        }
        console.log('PASS in-flight scope/logout discard and delayed listing isolation',name);
      }
    } finally {await browser.close();}
  }
} finally {await fixture.close();}
mkdirSync(resolve(root,'tmp'),{recursive:true});
writeFileSync(resolve(root,`tmp/thumbnail-${before?'before':'after'}.json`),JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
