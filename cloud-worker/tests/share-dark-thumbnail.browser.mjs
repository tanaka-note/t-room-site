import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {engines,startUIFixture,root,makeVideoFixture} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce');
const fixture=await startUIFixture(before?resolve(root,'tmp/share-dark-baseline'):root);
try{for(const [name,engine,launch] of engines){
  const browser=await engine.launch({headless:true,...launch});
  try{
    for(const scenario of before?['recover']:['recover','unavailable','pagehide']){
      const page=await browser.newPage({viewport:{width:1280,height:800}});
      await page.addInitScript(()=>{globalThis.idbOpens=0;const open=indexedDB.open.bind(indexedDB);indexedDB.open=(...args)=>{idbOpens++;return open(...args);};});
      await page.goto(fixture.origin+'/cloud/share/'+'A'.repeat(43));await page.waitForFunction(()=>globalThis.__share);
      const payload=await page.evaluate(async scenario=>{
        __share.bindEvents();
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const c=canvas.getContext('2d');
        c.fillStyle='#208080';c.fillRect(0,0,64,64);const good=await new Promise(r=>canvas.toBlob(r,'image/png'));
        c.fillStyle='#000';c.fillRect(0,0,64,64);const dark=await new Promise(r=>canvas.toBlob(r,'image/png'));
        const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
        __share.prepare(Array.from({length:4},(_,i)=>({id:i+1,name:'fixture '+i,mediaKind:'video',mimeType:'video/mp4',fileKey:key,cryptoVersion:1,hasThumbnail:true})));
        globalThis.repairStats={active:0,max:0,started:0,released:0,paths:[]};
        globalThis.TCloudMedia={...TCloudMedia,registerMedia:async(file,key,path)=>{repairStats.paths.push(path);return {token:String(file.id),url:'fixture'};},releaseMedia:()=>{repairStats.released++;}};
        globalThis.TCloudUI={...TCloudUI,recoverVideoThumbnail:async(url,signal)=>{
          repairStats.started++;repairStats.active++;repairStats.max=Math.max(repairStats.max,repairStats.active);
          try{await new Promise(r=>setTimeout(r,scenario==='pagehide'?500:80));return scenario==='unavailable'?null:good;}
          finally{repairStats.active--;}
        }};
        return {good:Array.from(new Uint8Array(await(await TRoomCrypto.encryptThumbnail(good,key)).arrayBuffer())),dark:Array.from(new Uint8Array(await(await TRoomCrypto.encryptThumbnail(dark,key)).arrayBuffer()))};
      },scenario);
      const requests=[];
      await page.route('**/cloud/api/**',route=>{requests.push({method:route.request().method(),body:route.request().postData()});return route.fulfill({body:Buffer.from(route.request().url().endsWith('/1/thumbnail')?payload.good:payload.dark)});});
      await page.evaluate(()=>__share.renderSortedItems());
      await page.waitForFunction(()=>[...__share.state.thumbnailTasks.values()].every(t=>t.status==='done'));
      if(before){
        const result=await page.evaluate(()=>({images:document.querySelectorAll('#items .thumb img').length,dark:[...document.querySelectorAll('#items .thumb img')].filter(i=>TCloudUI.isBlankVideoFrame(i)).length}));
        assert.deepEqual(result,{images:4,dark:3});console.log('REPRODUCED share accepts three black images as successful thumbnails',name,result);
      }else{
        if(scenario==='pagehide'){await page.waitForFunction(()=>repairStats.started>0);await page.evaluate(()=>dispatchEvent(new Event('pagehide')));}
        await page.waitForFunction(()=>__share.state.thumbnailRepairActive===0&&[...__share.state.thumbnailTasks.values()].every(t=>!t.repair||t.repair==='done'));
        const result=await page.evaluate(()=>({images:document.querySelectorAll('#items .thumb img').length,icons:document.querySelectorAll('#items .thumb svg').length,dark:[...document.querySelectorAll('#items .thumb img')].filter(i=>TCloudUI.isBlankVideoFrame(i)).length,idb:idbOpens,...repairStats}));
        assert.equal(result.dark,0);assert.equal(result.idb,0);assert.equal(result.max,1);assert.ok(result.released>=result.started);
        assert.equal(result.images,scenario==='recover'?4:scenario==='unavailable'?1:0);
        if(scenario==='unavailable')assert.equal(result.icons,3);
        assert.ok(result.paths.every(p=>/^\/cloud\/api\/public\/shares\/A{43}\/files\/[234]\/view$/.test(p)));
        console.log('PASS shared dark-frame recovery, memory-only, one active, release',name,scenario,{images:result.images,icons:result.icons,started:result.started,max:result.max,idb:result.idb});
      }
      assert.ok(requests.every(r=>r.method==='GET'&&r.body===null));await page.close();
    }
    if(!before&&name==='chromium'){
      const video=await makeVideoFixture(fixture.origin,{durationMs:6000,darkIntroMs:2100});
      const page=await browser.newPage();await page.goto(fixture.origin+'/cloud/');
      const result=await page.evaluate(async video=>{
        const url=URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type}));
        try{const blob=await TCloudUI.recoverVideoThumbnail(url,new AbortController().signal);const decoded=await TCloudUI.decodeThumbnail(blob);const blank=TCloudUI.isBlankVideoFrame(decoded.image);URL.revokeObjectURL(decoded.url);return {blank,size:blob.size};}finally{URL.revokeObjectURL(url);}
      },video);
      assert.equal(result.blank,false);assert.ok(result.size>0);console.log('PASS real bounded video frame recovery',name,result);await page.close();
    }
  }finally{await browser.close();}
}}finally{await fixture.close();}
