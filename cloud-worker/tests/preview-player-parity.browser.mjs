import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engines,startUIFixture,preparePage,makeVideoFixture} from './ui-fixture.mjs';

const reproduce=process.argv.includes('--reproduce');
for(const [source,runtime] of [['cloud.css','cloud-runtime-20260815-1.css'],['share.css','share-runtime-20260814-6.css'],['cloud.js','cloud-runtime-20260816-1.js'],['share.js','share-runtime-20260816-1.js']]){
 const read=name=>readFileSync(new URL('../public/'+name,import.meta.url),'utf8').replace(/\r\n/g,'\n');
 assert.equal(read(source),read(runtime),source+' must match its published runtime');
}
const fixture=await startUIFixture(),video=await makeVideoFixture(fixture.origin);
const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
try {for(const [name,engine,launch] of engines.filter(([n])=>!process.argv.includes("--webkit-only")||n==="webkit")){
 const browser=await engine.launch({headless:true,...launch});
 try {for(const [shared,standalone] of [[false,false],[false,true],[true,false],[true,true]]){
  const context=await browser.newContext({viewport:{width:390,height:740},hasTouch:true});
  if(standalone){
   await context.addCookies([{name:'standalone',value:'1',url:fixture.origin}]);
   await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));
  }
  const page=await context.newPage();page.on("pageerror",e=>console.log("PAGE ERROR",name,shared,e.message));
  // Simulate asymmetric device insets, including rotation; no production data.
  await page.route(/\/cloud\/.*\.css(?:\?|$)/,async route=>{
   const response=await route.fetch();const css=(await response.text()).replaceAll('env(safe-area-inset-left)','20px').replaceAll('env(safe-area-inset-right)','30px');
   await route.fulfill({response,body:css});
  });
  await page.route('**/cloud/api/**',r=>r.fulfill({json:{}}));
  if(shared){
   await page.goto(fixture.origin+'/cloud/share/'+'A'.repeat(43));await page.waitForFunction(()=>globalThis.__share);
   await page.evaluate(video=>{
    __share.bindEvents();__share.videoFixture(URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type})));
    __share.prepare([{id:2,name:'Video fixture',mediaKind:'video',mimeType:video.type,createdAt:'2026-09-20 00:00:00',sizeBytes:100}]);__share.renderSortedItems();
   },video);
   await page.locator('#items .file > button:first-child').click();
  }else{
   await preparePage(page,fixture.origin,4);
   await page.evaluate(video=>{
    __test.videoFixture(URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type})));
    __test.state.files.forEach(f=>{f.hasThumbnail=false;f.mimeType=video.type;});
   },video);
   await page.locator('.file-card[data-file-id="2"] > button:first-child').click();
  }
  await page.waitForSelector('.preview-player-controls').catch(async e=>{console.log('PREVIEW STATE',name,shared,await page.evaluate(()=>({open:document.querySelector('#preview-dialog')?.open,stage:document.querySelector('#preview-stage')?.innerHTML})));throw e;});
  const initial=await page.locator('.preview-player-mode svg').evaluate(el=>getComputedStyle(el).fill);
  if(reproduce&&shared){assert.notEqual(initial,'none');console.log('REPRODUCED shared repeat SVG filled',name);await context.close();continue;}
  if(!reproduce)assert.equal(initial,'none');
  for(const size of [{width:320,height:568},{width:360,height:740},{width:390,height:740},{width:430,height:740},{width:599,height:740},{width:600,height:740},{width:601,height:740},{width:1280,height:900},{width:740,height:360}]){
   await page.setViewportSize(size);
   await page.locator('.preview-player-controls').scrollIntoViewIfNeeded();
   const layout=await page.evaluate(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
    const controls=document.querySelector('.preview-player-controls');
    return {buttons:[...controls.querySelectorAll('button')].map(rect),seek:rect(controls.querySelector('[role="slider"]')),fill:getComputedStyle(controls.querySelector('.preview-player-mode svg')).fill};
   });
   if(!reproduce){
    for(const r of [...layout.buttons,layout.seek])assert.ok(r.left>=-1&&r.right<=size.width+1,JSON.stringify({name,shared,size,layout}));
    for(let i=0;i<layout.buttons.length;i++)for(let j=i+1;j<layout.buttons.length;j++)assert.equal(overlap(layout.buttons[i],layout.buttons[j]),false);
    assert.ok(layout.seek.width>=100,JSON.stringify({name,shared,size,layout}));
    assert.equal(layout.fill,'none');
    if(size.width<=600)assert.ok(layout.buttons[1].top>=layout.buttons[0].bottom);
   }
   if(!shared&&size.width<=900){
    await page.locator('#preview-more summary').click();
    await page.waitForTimeout(80);
    const menu=await page.evaluate(()=>{
     const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
     const panel=document.querySelector('.preview-more-menu');
     return {panel:rect(panel),controls:rect(document.querySelector('.preview-player-controls')),buttons:[...panel.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>({id:b.id,...rect(b),hit:document.elementFromPoint(b.getBoundingClientRect().x+b.offsetWidth/2,b.getBoundingClientRect().y+b.offsetHeight/2)===b})),summary:rect(document.querySelector('#preview-more summary')),actions:[...document.querySelectorAll('.preview-actions > button,.preview-actions > a')].filter(b=>!b.hidden).map(rect)};
    });
    if(reproduce){assert.equal(overlap(menu.panel,menu.controls),true);console.log('REPRODUCED mobile More overlaps playback',name,size.width);break;}
    assert.equal(overlap(menu.panel,menu.controls),false,JSON.stringify(menu));
    for(const r of [...menu.actions,menu.summary])assert.equal(overlap(menu.panel,r),false);
    assert.ok(menu.panel.left>=0&&menu.panel.right<=size.width&&menu.panel.top>=0&&menu.panel.bottom<=size.height+1,JSON.stringify({size,menu}));
    assert.deepEqual(menu.buttons.map(b=>b.id),['share-file-button','edit-file-button','manual-thumbnail-button']);
    assert.ok(menu.buttons.every(b=>b.hit),JSON.stringify(menu));
    await page.locator('#preview-more summary').click();
   }
  }
  if(!reproduce){
   await page.setViewportSize({width:390,height:740});
   const mode=page.locator('.preview-player-mode');await mode.click();
   assert.equal(await mode.getAttribute('aria-pressed'),'true');assert.equal(await mode.getAttribute('aria-label'),'動画リピート');
   assert.equal(await page.locator('video').evaluate(v=>v.loop),true);
   assert.ok((await mode.getAttribute('class')).includes('is-active'));
   if(name==='chromium'){
    await page.locator('video').evaluate(async v=>{v.muted=true;await v.play();});
    await page.waitForFunction(()=>document.querySelector('video').currentTime>.05);
    if(!standalone){
     assert.equal(await page.locator('video').evaluate(v=>new Promise(resolve=>{
      let previous=v.currentTime;const end=performance.now()+5000;
      const timer=setInterval(()=>{const current=v.currentTime;if(current<previous-.05){clearInterval(timer);resolve(true);}else if(performance.now()>end){clearInterval(timer);resolve(false);}previous=current;},30);
     })),true,'native video loops at the end');
    }
    await page.locator('.preview-player-play').click();
    assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
   }
   await mode.click();assert.equal(await mode.getAttribute('aria-pressed'),'false');assert.equal(await page.locator('video').evaluate(v=>v.loop),false);
   const muted=await page.locator('video').evaluate(v=>v.muted);await page.locator('.preview-player-mute').click();assert.equal(await page.locator('video').evaluate(v=>v.muted),!muted);
   // Deterministic media events keep UI assertions independent of OS codecs.
   await page.locator('video').evaluate(v=>{Object.defineProperty(v,'currentTime',{configurable:true,writable:true,value:0});Object.defineProperty(v,'duration',{configurable:true,value:120});Object.defineProperty(v,'buffered',{configurable:true,value:{length:1,end:()=>90}});v.dispatchEvent(new Event('progress'));v.dispatchEvent(new Event('durationchange'));});
   await page.waitForFunction(()=>document.querySelector('.preview-player-seek')?.getAttribute('aria-disabled')==='false');
   assert.equal(await page.locator('.preview-player-seek').getAttribute('aria-disabled'),'false');
   assert.equal(await page.locator('.preview-player-seek').evaluate(e=>e.style.getPropertyValue('--buffered-percent')),'75.00%');
   await page.locator('.preview-player-seek').press('ArrowRight');
   assert.ok(await page.locator('video').evaluate(v=>v.currentTime>=5));
   assert.equal(await page.locator('video').getAttribute('preload'),'auto');
   await page.evaluate(()=>{globalThis.TCloudMedia={...TCloudMedia,markPlaying:()=>document.querySelector('video').dataset.playingNotified='true'};document.querySelector('video').dispatchEvent(new Event('playing'));});
   assert.equal(await page.locator('video').getAttribute('data-playing-notified'),'true');
   // Exercise the actual fullscreen handler while stubbing only the OS API.
   await page.evaluate(()=>{document.querySelector('.preview-stage-wrap').requestFullscreen=async()=>{document.querySelector('.preview-stage-wrap').dataset.fullscreenRequested='true';};});
   await page.locator('.preview-player-fullscreen').click();
   assert.equal(await page.locator('.preview-stage-wrap').getAttribute('data-fullscreen-requested'),'true');
   // Existing audio mode cycle and automatic advance use the real app handlers.
   await page.evaluate(async shared=>{
    const app=shared?__share:__test;
    app.state.files=[31,32].map(id=>({id,name:'Audio fixture '+id,mediaKind:'audio',mimeType:'audio/wav',cryptoVersion:1,fileKey:globalThis.__thumb?.key,createdAt:'2026-09-20 00:00:00',sizeBytes:100}));
    await app.openPreview(app.state.files[0],{pushHistory:false});
   },shared);
   const audioMode=page.locator('.preview-audio-playback-mode');
   await audioMode.click();assert.equal(await audioMode.getAttribute('aria-label'),'1曲リピート');assert.equal(await page.locator('audio').evaluate(v=>v.loop),true);
   await audioMode.click();assert.equal(await audioMode.getAttribute('aria-label'),'連続再生');assert.equal(await page.locator('audio').evaluate(v=>v.loop),false);
   await page.locator('audio').evaluate(v=>v.dispatchEvent(new Event('ended')));
   await page.waitForFunction(shared=>(shared?__share:__test).state.selected?.id===32,shared);
   await audioMode.click();assert.equal(await audioMode.getAttribute('aria-label'),'リピート：オフ');
   console.log('PASS player layout/actions',name,shared?'shared':'normal',{standalone,viewports:9});
  }
  await context.close();
 }}finally{await browser.close();}
}}finally{await fixture.close();}
