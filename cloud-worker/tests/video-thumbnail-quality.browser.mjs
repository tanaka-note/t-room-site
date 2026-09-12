import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce'),fixture=await startUIFixture();
try{for(const [name,engine,launch] of engines){
  const browser=await engine.launch({headless:true,...launch});
  try{
    const page=await browser.newPage();await preparePage(page,fixture.origin,1);
    const result=await page.evaluate(async before=>{
      __test.state.view='history';const file=__test.state.files[0];file.mediaKind='video';
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
      const c=canvas.getContext('2d');c.fillRect(0,0,64,36);
      const black=await new Promise(r=>canvas.toBlob(r,'image/png'));
      const stage=document.querySelector('.thumb');
      let blackInserted=false;
      const replace=stage.replaceChildren.bind(stage);
      stage.replaceChildren=(...nodes)=>{if(nodes.some(n=>n.tagName==='IMG'&&TCloudUI.isBlankVideoFrame(n)))blackInserted=true;return replace(...nodes);};
      await __test.installThumbnailBlob(file,stage,black);
      const displayed=stage.querySelectorAll('img').length;
      let time=0;const seeks=[];
      Object.assign(canvas,{duration:100,readyState:4,videoWidth:64,videoHeight:36});
      Object.defineProperty(canvas,'currentTime',{get:()=>time,set:value=>{
        time=value;seeks.push(value);c.fillStyle='#000';c.fillRect(0,0,64,36);
        if(value>=75){c.fillStyle='#fff';c.fillRect(32,0,32,36);c.fillStyle='#f00';c.fillRect(0,0,16,36);}
        queueMicrotask(()=>canvas.dispatchEvent(new Event('seeked')));
      }});
      const selected=await __test.chooseVideoThumbnailFrame(canvas);
      return {displayed,blackInserted,seeks,selected:!!selected,icons:stage.querySelectorAll('svg').length};
    },before);
    if(before){assert.equal(result.displayed,1);assert.equal(result.blackInserted,true);assert.equal(result.selected,false);console.log('REPRODUCED black image committed to DOM and later visible scene missed',name,result);}
    else{
      assert.equal(result.displayed,0);assert.equal(result.blackInserted,false);assert.equal(result.icons,1);
      assert.equal(result.selected,true);assert.deepEqual(result.seeks,[10,25,50,75]);
      console.log('PASS black never committed to DOM; 75 percent scene selected',name,result);
      const scenarios=await page.evaluate(async()=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const c=canvas.getContext('2d');
        const quality=(a,b=a)=>{c.fillStyle=`rgb(${a},${a},${a})`;c.fillRect(0,0,64,36);c.fillStyle=`rgb(${b},${b},${b})`;c.fillRect(32,0,32,36);return TCloudUI.videoFrameQuality(canvas);};
        const black=quality(0),near=quality(12),flatDark=quality(20),darkDetail=quality(12,55),good=quality(0,255);
        let time=0,seeks=[];Object.assign(canvas,{duration:100,readyState:4,videoWidth:64,videoHeight:36});
        Object.defineProperty(canvas,'currentTime',{get:()=>time,set:v=>{time=v;seeks.push(v);quality(0);queueMicrotask(()=>canvas.dispatchEvent(new Event('seeked')));}});
        quality(0);const allBlack=await TCloudUI.selectVideoThumbnailFrame(canvas);
        const blackSeeks=[...seeks];seeks=[];quality(0,255);const firstGood=await TCloudUI.selectVideoThumbnailFrame(canvas);
        const earlySeeks=[...seeks];
        const controller=new AbortController();controller.abort();let aborted=false;
        try{await TCloudUI.selectVideoThumbnailFrame(canvas,{signal:controller.signal});}catch(e){aborted=e.name==='AbortError';}
        return {black,near,flatDark,darkDetail,good,allBlack:allBlack===null,blackSeeks,firstGood:!!firstGood,earlySeeks,aborted};
      });
      assert.equal(scenarios.black.accepted,false);assert.equal(scenarios.near.accepted,false);assert.equal(scenarios.flatDark.accepted,false);
      assert.equal(scenarios.darkDetail.accepted,true);assert.ok(scenarios.good.score>scenarios.darkDetail.score);
      assert.equal(scenarios.allBlack,true);assert.deepEqual(scenarios.blackSeeks,[10,25,50,75,90]);
      assert.equal(scenarios.firstGood,true);assert.deepEqual(scenarios.earlySeeks,[]);assert.equal(scenarios.aborted,true);
      console.log('PASS quality scoring, all-black fallback, five-seek cap, early success, abort',name);
      const bestCandidate=await page.evaluate(async()=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const c=canvas.getContext('2d');
        let time=0;const seeks=[];
        const paint=value=>{c.fillStyle='#202020';c.fillRect(0,0,64,36);c.fillStyle=value===50?'#808080':'#404040';c.fillRect(32,0,32,36);};
        Object.assign(canvas,{duration:100,readyState:4,videoWidth:64,videoHeight:36});
        Object.defineProperty(canvas,'currentTime',{get:()=>time,set:v=>{time=v;seeks.push(v);paint(v);queueMicrotask(()=>canvas.dispatchEvent(new Event('seeked')));}});
        paint(0);const blob=await TCloudUI.selectVideoThumbnailFrame(canvas);
        const decoded=await TCloudUI.decodeThumbnail(blob);
        try{return {seeks,quality:TCloudUI.videoFrameQuality(decoded.image)};}finally{URL.revokeObjectURL(decoded.url);}
      });
      assert.deepEqual(bestCandidate.seeks,[10,25,50,75,90]);assert.ok(bestCandidate.quality.score>55&&bestCandidate.quality.score<65);
      console.log('PASS best acceptable middle candidate retained over later lower scores',name);
      await preparePage(page,fixture.origin,84);
      const payload=Buffer.from(await page.evaluate(()=>__thumb.encrypted.arrayBuffer().then(bytes=>[...new Uint8Array(bytes)])));
      let requests=0;
      await page.route('**/cloud/api/**',route=>{requests++;assert.equal(route.request().method(),'GET');return route.fulfill({body:payload});});
      await page.evaluate(()=>{
        globalThis.registrations=0;globalThis.TCloudMedia={...TCloudMedia,registerMedia:async()=>{registrations++;throw new Error('Healthy thumbnails must not decode videos');}};
        for(const file of __test.state.files){file.mediaKind='video';file.durationSeconds=100;}
        __test.scheduleEncryptedThumbnailLoading();
      });
      await page.waitForFunction(()=>document.querySelectorAll('.thumb img').length===84&&__test.state.thumbnailLoadActive===0);
      await page.evaluate(()=>{__test.state.query='fixture';document.querySelector('#content-grid').replaceChildren(...__test.state.files.map(__test.fileCard));});
      await page.waitForFunction(()=>document.querySelectorAll('.thumb img').length===84);
      assert.equal(await page.evaluate(()=>registrations),0);assert.equal(requests,84);
      console.log('PASS 84 healthy videos, API then cached search cards: no video registrations or seeks',name);
      await page.unroute('**/cloud/api/**');
      await preparePage(page,fixture.origin,1);
      const bad=await page.evaluate(async()=>{
        __test.state.view='history';const file=__test.state.files[0];file.mediaKind='video';
        const canvas=document.createElement('canvas');canvas.width=32;canvas.height=18;canvas.getContext('2d').fillRect(0,0,32,18);
        const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
        await TCloudDisplayCache.putThumbnail(__test.displayCacheScope(),file.id,file.createdAt,blob);
        return [...new Uint8Array(await(await TRoomCrypto.encryptThumbnail(blob,file.fileKey)).arrayBuffer())];
      });
      await page.route('**/cloud/api/**',route=>route.fulfill({body:Buffer.from(bad)}));
      await page.evaluate(()=>__test.scheduleEncryptedThumbnailLoading());
      await page.waitForFunction(()=>__test.state.thumbnailLoadTasks.get(1)?.status==='stopped');
      const cacheResult=await page.evaluate(async()=>({images:document.querySelectorAll('.thumb img').length,icons:document.querySelectorAll('.thumb svg').length,
        cached:!!await TCloudDisplayCache.getThumbnail(__test.displayCacheScope(),1,__test.state.files[0].createdAt),repair:__test.state.files[0].thumbnailNeedsRepair}));
      assert.deepEqual(cacheResult,{images:0,icons:1,cached:false,repair:true});
      console.log('PASS rejected IndexedDB/API image removed without persisting black replacement',name);
      await page.unroute('**/cloud/api/**');
      await preparePage(page,fixture.origin,1);
      await page.route('**/held-video',async route=>{await new Promise(r=>setTimeout(r,200));await route.fulfill({status:404,body:''}).catch(()=>{});});
      let writes=0;await page.route('**/cloud/api/**',route=>{writes++;return route.fulfill({json:{ok:true}});});
      const cancellation=await page.evaluate(async()=>{
        let released=0;globalThis.TCloudMedia={...TCloudMedia,registerMedia:async()=>({token:'fixture',url:'/held-video'}),releaseMedia:()=>released++};
        const file=__test.state.files[0];file.mediaKind='video';file.durationSeconds=100;
        const pending=__test.backfillVideoThumbnail(file,__test.state.itemLoadGeneration);
        await new Promise(r=>setTimeout(r,20));const controller=[...__test.state.thumbnailBackfillControllers][0];
        __test.releaseSessionState();await pending;
        return {aborted:controller.signal.aborted,released:released>0,controllers:__test.state.thumbnailBackfillControllers.size,tokens:__test.state.backgroundMediaTokens.size};
      });
      assert.deepEqual(cancellation,{aborted:true,released:true,controllers:0,tokens:0});assert.equal(writes,0);
      console.log('PASS admin repair cancellation releases media and prevents late PUT',name);
    }
    await page.close();
  }finally{await browser.close();}
}}finally{await fixture.close();}
