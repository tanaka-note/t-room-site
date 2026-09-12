import assert from 'node:assert/strict';
import {engines,root,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce');
const fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT||root);
try {
  for(const [name,engine,launch] of engines) {
    const browser=await engine.launch({headless:true,...launch});
    try {
      const page=await browser.newPage({viewport:{width:390,height:740}});
      await preparePage(page,fixture.origin,32);
      const held=[];let thumbnailCalls=0;
      await page.route('**/cloud/api/**',async route=>{
        if(route.request().url().includes('/items?'))return route.fulfill({json:{files:Array.from({length:96},(_,i)=>({id:i+33,name:'fixture '+i,mediaKind:'image',cryptoVersion:0,searchDepth:1,searchPath:'root / child',hasThumbnail:false})),folders:[]}});
        thumbnailCalls++;await new Promise(r=>held.push(r));await route.fulfill({status:404,body:''}).catch(()=>{});
      });
      await page.evaluate(()=>{
        __test.state.query='fixture';__test.renderItems();
        globalThis.oldStage=document.querySelector('.file-card .thumb');
        __test.state.progressiveItemsLoading=true;__test.state.itemNextFileOffset=32;
        __test.state.itemPageParams='q=fixture&recursive=1';__test.state.itemLoadController=new AbortController();
      });
      await page.waitForFunction(()=>__test.state.thumbnailLoadActive===4);
      await page.evaluate(()=>__test.loadNextItemPage());
      const search=await page.evaluate(()=>({connected:oldStage.isConnected,same:oldStage===document.querySelector('.file-card .thumb'),files:__test.state.files.length}));
      assert.equal(search.files,128);
      assert.equal(search.connected,!before);assert.equal(search.same,!before);
      if(!before){
        await page.evaluate(()=>{__test.state.files[0].durationPending=true;__test.renderItems();});
        assert.equal(await page.evaluate(()=>oldStage===document.querySelector('.file-card .thumb')&&oldStage.isConnected),true);
      }
      held.forEach(r=>r());await page.close();
      console.log(before?'REPRODUCED search pagination destroys active stage':'PASS search pagination preserves active stage',name,search);

      const share=await browser.newPage({viewport:{width:390,height:740}});
      await share.goto(fixture.origin+'/cloud/share/'+'A'.repeat(43));
      await share.waitForFunction(()=>globalThis.__share);
      const image=await share.evaluate(async()=>{
        const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillRect(0,0,64,64);
        const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
        globalThis.shareKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
        return {plain:Array.from(new Uint8Array(await blob.arrayBuffer())),encrypted:Array.from(new Uint8Array(await (await TRoomCrypto.encryptThumbnail(blob,shareKey)).arrayBuffer()))};
      });
      const calls=[];let active=0,maxActive=0;
      await share.route('**/cloud/api/public/shares/**',async route=>{
        assert.equal(route.request().method(),'GET');assert.equal(route.request().postData(),null);
        const url=route.request().url();calls.push(url);active++;maxActive=Math.max(active,maxActive);
        await new Promise(r=>setTimeout(r,50));
        await route.fulfill(url.endsWith('/display-thumbnail')?{body:Buffer.from(image.plain),contentType:'image/png'}:{status:404,body:''});active--;
      });
      await share.evaluate(()=>{
        __share.bindEvents();
        __share.prepare(Array.from({length:32},(_,i)=>({id:i+1,name:'fixture '+i,mediaKind:'image',cryptoVersion:1,hasThumbnail:true,hasDisplayThumbnail:true,fileKey:shareKey})));
        __share.renderSortedItems();
      });
      if(before)await share.waitForTimeout(300);
      else await share.waitForFunction(()=>document.querySelectorAll('#items .thumb img').length===32);
      const count=await share.locator('#items .thumb img').count();
      assert.equal(count,before?0:32);assert.ok(before?maxActive>4:maxActive<=4);
      const oldCalls=calls.length;
      await share.evaluate(()=>__share.changeSharedSort('name'));
      await share.waitForTimeout(200);
      assert.equal(calls.length>oldCalls,before);
      console.log(before?'REPRODUCED display-only share 404 and unbounded duplicate loads':'PASS display-only share, four jobs, sort reuse',name,{images:count,maxActive,extraCalls:calls.length-oldCalls});
      await share.close();
    } finally {await browser.close();}
  }
} finally {await fixture.close();}
