import assert from 'node:assert/strict';
import {engines,root,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce'),fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT||root);
try{for(const [engineName,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{for(const surface of ['normal','search','share'])for(const count of [32,128,500]){
  if(process.env.BENCH_CASE && process.env.BENCH_CASE!==engineName+':'+surface+':'+count)continue;
  const page=await browser.newPage({viewport:{width:390,height:740}});
  let payload;
  if(surface!=='share'){
   await preparePage(page,fixture.origin,count);
   payload=await page.evaluate(async surface=>{
    __test.state.query=surface==='search'?'fixture':'';
    __test.state.files.forEach(f=>f.mediaKind='image');
    return Array.from(new Uint8Array(await __thumb.encrypted.arrayBuffer()));
   },surface);
  }else{
   await page.goto(fixture.origin+'/cloud/share/'+'A'.repeat(43));await page.waitForFunction(()=>globalThis.__share);
   payload=await page.evaluate(async count=>{
    __share.bindEvents();const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
    const c=document.createElement('canvas');c.width=64;c.height=64;c.getContext('2d').fillStyle='#208080';c.getContext('2d').fillRect(0,0,64,64);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    __share.prepare(Array.from({length:count},(_,i)=>({id:i+1,name:'fixture '+i,fileKey:key,mediaKind:'video',hasThumbnail:true,cryptoVersion:1,createdAt:'2026-09-12 00:00:00'})));
    return Array.from(new Uint8Array(await(await TRoomCrypto.encryptThumbnail(blob,key)).arrayBuffer()));
   },count);
  }
  let calls=0,active=0,maxActive=0;
  await page.route('**/cloud/api/**',async route=>{
   assert.equal(route.request().method(),'GET');assert.equal(route.request().postData(),null);
   calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,8));
   await route.fulfill({body:Buffer.from(payload)}).catch(()=>{});active--;
  });
  for(const cache of ['cold','warm']){
   const previous=calls;maxActive=0;
   await page.evaluate(({surface,cache})=>{
    globalThis.startedAt=performance.now();globalThis.visibleDone=null;
    if(surface==='share')__share.renderSortedItems();
    else {if(cache==='warm'){__test.resetEncryptedThumbnailLoading();document.querySelector('#content-grid').replaceChildren();}__test.renderItems();}
    const watch=()=>{
     const bounds=surface==='share'?{top:0,bottom:innerHeight}:document.querySelector('.workspace').getBoundingClientRect();
     const stages=[...document.querySelectorAll(surface==='share'?'#items .thumb':'#content-grid .thumb')].filter(el=>{const r=el.getBoundingClientRect();return r.top<bounds.bottom&&r.bottom>bounds.top;});
     if(stages.length&&stages.every(s=>s.querySelector('img')?.naturalWidth))visibleDone=performance.now()-startedAt;
     else requestAnimationFrame(watch);
    };watch();
   },{surface,cache});
   try {await page.waitForFunction(count=>document.querySelectorAll('.thumb img').length===count&&visibleDone!==null,count,{timeout:180000});}
   catch(error){console.log('BENCH DIAGNOSTIC',engineName,surface,count,await page.evaluate(()=>({images:document.querySelectorAll('.thumb img').length,cards:document.querySelectorAll('.thumb').length,visibleDone,active:globalThis.__test?.state.thumbnailLoadActive,tasks:globalThis.__test?[...__test.state.thumbnailLoadTasks.values()].reduce((acc,t)=>(acc[t.status]=(acc[t.status]||0)+1,acc),{}):null})));throw error;}
   // Cache writes settle before a cold/warm transition.
   if(surface!=='share')await page.waitForFunction(()=>__test.state.thumbnailLoadActive===0);
   const milliseconds=await page.evaluate(()=>Math.round(visibleDone));
   if(!before) {assert.ok(maxActive<=4);if(cache==='warm')assert.equal(calls,previous);}
   console.log(JSON.stringify({phase:before?'before':'after',engine:engineName,surface,count,cache,viewportMs:milliseconds,fetches:calls-previous,maxActive}));
  }
  await page.close();
 }}finally{await browser.close();}
}}finally{await fixture.close();}
