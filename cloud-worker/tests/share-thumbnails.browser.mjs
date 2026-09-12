import assert from 'node:assert/strict';
import {engines,startUIFixture} from './ui-fixture.mjs';
const fixture=await startUIFixture();
async function prepare(browser,count=1){
 const page=await browser.newPage({viewport:{width:390,height:740}});
 await page.addInitScript(()=>{globalThis.idbOpens=0;const open=indexedDB.open.bind(indexedDB);indexedDB.open=(...args)=>{idbOpens++;return open(...args);};});
 await page.goto(fixture.origin+'/cloud/share/'+'A'.repeat(43));await page.waitForFunction(()=>globalThis.__share);
 const payload=await page.evaluate(async count=>{
  __share.bindEvents();
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillStyle='#208080';canvas.getContext('2d').fillRect(0,0,64,64);
  const blob=await new Promise(r=>canvas.toBlob(r,'image/png')),key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  __share.prepare(Array.from({length:count},(_,i)=>({id:i+1,name:'fixture '+i,mediaKind:'video',mimeType:'video/mp4',fileKey:key,cryptoVersion:1,hasThumbnail:true,createdAt:'2026-09-12 00:00:00'})));
  return {plain:Array.from(new Uint8Array(await blob.arrayBuffer())),encrypted:Array.from(new Uint8Array(await(await TRoomCrypto.encryptThumbnail(blob,key)).arrayBuffer()))};
 },count);
 return {page,payload};
}
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{
  for(const scenario of ['ok','display','display-fallback','none','no-key',500,429,408,'network','503-limit',404,401,403,410,419,'wrong-key','invalid-image','decode-timeout']){
   const {page,payload}=await prepare(browser);const calls=[];
   await page.route('**/cloud/api/**',async route=>{
    assert.equal(route.request().method(),'GET');assert.equal(route.request().postData(),null);
    const url=route.request().url();calls.push(url);
    if(scenario==='503-limit')return route.fulfill({status:503,body:''});
    if(scenario==='network'&&calls.length===1)return route.abort('failed');
    if(typeof scenario==='number'&&(scenario<500&&![408,429].includes(scenario)||calls.length===1))return route.fulfill({status:scenario,body:''});
    if(scenario==='display-fallback'&&url.endsWith('display-thumbnail'))return route.fulfill({body:'invalid'});
    return route.fulfill({body:Buffer.from(url.endsWith('display-thumbnail')?payload.plain:payload.encrypted)});
   });
   await page.evaluate(async scenario=>{
    const file=__share.state.files[0];
    if(scenario==='none')file.hasThumbnail=false;
    if(scenario==='no-key')file.fileKey=null;
    if(String(scenario).startsWith('display')){file.mediaKind='image';file.hasDisplayThumbnail=true;}
    if(scenario==='wrong-key')file.fileKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['decrypt']);
    if(scenario==='invalid-image'||scenario==='decode-timeout'){
     let count=0;const decode=TCloudUI.decodeThumbnail;
     globalThis.TCloudUI={...TCloudUI,decodeThumbnail:async(...args)=>{
      if(scenario==='invalid-image'||count++===0)throw Object.assign(new Error('fixture decode'),{thumbnailTransient:scenario==='decode-timeout'});
      return decode(...args);
     }};
    }
    __share.renderSortedItems();
   },scenario);
   await page.waitForFunction(()=>document.querySelector('#unlock-view').hidden===false||__share.state.thumbnailTasks.size===0||__share.state.thumbnailTasks.get(1)?.status==='done');
   await page.waitForTimeout(100);
   const success=['ok','display','display-fallback',500,429,408,'network','decode-timeout'].includes(scenario);
   assert.equal(await page.locator('#items .thumb img').count(),success?1:0,String(scenario));
   const expected=['none','no-key'].includes(scenario)?0:scenario==='503-limit'?3:['display-fallback',500,429,408,'network','decode-timeout'].includes(scenario)?2:1;
   assert.equal(calls.length,expected,String(scenario));assert.equal(await page.evaluate(()=>idbOpens),0);
   if(![401,410,419].includes(scenario))assert.equal(await page.locator('#items .thumb .symbol').count(),success?0:1);
   console.log('PASS shared thumbnail',name,scenario,{requests:calls.length,persistentCacheWrites:0});await page.close();
  }
  // Scroll into background work while all four active requests are held.
  const {page,payload}=await prepare(browser,128);const held=[],calls=[];let active=0,maximum=0;
  await page.route('**/cloud/api/**',async route=>{
   calls.push(Number(route.request().url().match(/files\/(\d+)/)[1]));active++;maximum=Math.max(maximum,active);
   if(calls.length<=4)await new Promise(r=>held.push(r));
   await new Promise(r=>setTimeout(r,10));await route.fulfill({body:Buffer.from(payload.encrypted)}).catch(()=>{});active--;
  });
  await page.evaluate(()=>__share.renderSortedItems());await page.waitForFunction(()=>__share.state.thumbnailActive===4);
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  held.forEach(r=>r());await page.waitForFunction(()=>document.querySelectorAll('#items .thumb img').length===128);
  assert.ok(calls[4]>100,JSON.stringify(calls.slice(0,8)));assert.ok(maximum<=4);
  const old=calls.length;
  await page.locator('#share-search').fill('fixture 12');await page.waitForFunction(()=>document.querySelectorAll('#items .file').length===9);
  await page.locator('#share-search-clear').click();await page.locator('#share-kind').selectOption('image');assert.equal(await page.locator('#items .file').count(),0);
  await page.locator('#share-kind').selectOption('');await page.evaluate(()=>__share.changeSharedSort('name'));await page.locator('#share-display-toggle').click();
  assert.equal(calls.length,old);assert.equal(await page.locator('#items .thumb img').count(),128);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.locator('#items .thumb img').count(),0);assert.equal(await page.evaluate(()=>__share.state.thumbnailTasks.size),0);
  assert.equal(await page.evaluate(()=>idbOpens),0);
  console.log('PASS shared priority, filter/sort memory reuse, pagehide cleanup',name,{maximum,firstAfterScroll:calls[4],refetches:calls.length-old});await page.close();
  const interrupted=await prepare(browser,4);const pending=[];
  await interrupted.page.route('**/cloud/api/**',async route=>{await new Promise(r=>pending.push(r));await route.fulfill({body:Buffer.from(interrupted.payload.encrypted)}).catch(()=>{});});
  await interrupted.page.evaluate(()=>__share.renderSortedItems());while(pending.length<4)await interrupted.page.waitForTimeout(10);
  await interrupted.page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));pending.forEach(r=>r());
  await interrupted.page.waitForTimeout(150);
  assert.equal(await interrupted.page.locator('#items .thumb img').count(),0);
  assert.equal(await interrupted.page.evaluate(()=>__share.state.files.length+__share.state.folderKeys.size+__share.state.thumbnailTasks.size),0);
  console.log('PASS late shared responses rejected after invalidation',name);await interrupted.page.close();
 }finally{await browser.close();}
}}finally{await fixture.close();}
