import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, existsSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const {webkit,chromium,devices}=createRequire(new URL('../../diary-worker/package.json',import.meta.url))('playwright');
const root=process.env.TCLOUD_TEST_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const before=process.argv.includes('--reproduce');
const server=createServer((req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost');
  let path=url.pathname==='/cloud/'?'cloud-worker/public/index.html':url.pathname.startsWith('/cloud/')?'cloud-worker/public/'+url.pathname.slice(7):url.pathname.slice(1);
  if(path.startsWith('assets/')||path.startsWith('security/')) {res.setHeader('Content-Type','text/javascript');res.end('');return;}
  if(!path.startsWith('cloud-worker/public/')) {res.writeHead(404).end();return;}
  let data=readFileSync(resolve(root,path));
  // Playwright cannot launch an installed iOS PWA. Exercise its CSS branch
  // explicitly as well as navigator.standalone; this is emulation, not a device.
  if(path.endsWith('.css')&&req.headers.cookie?.includes('ui-standalone=1'))data=Buffer.from(data.toString().replaceAll('@media (display-mode: standalone)','@media all'));
  if(path==='cloud-worker/public/cloud.js') {
   data=Buffer.from(data.toString().replace('document.addEventListener("DOMContentLoaded", initialize);','')+`
    globalThis.__ui={state,fileCard,folderCard,installThumbnailBlob,loadEncryptedThumbnail,displayCacheScope,resetEncryptedThumbnailLoading,rememberCurrentNavigationPosition,restoreNavigationPosition,resetFolderScrollPosition,restorePreviewOrigin,selectFile,clearFileSelection,bindEvents};
    globalThis.__show=()=>{state.session={role:'admin',canDelete:true,canEditFiles:true,sessionCacheId:'fixture'};state.historyReady=true;state.credentialSalt='mobile-fixture';
     document.querySelector('#boot-view').hidden=true;document.querySelector('#login-view').hidden=true;document.querySelector('#app-view').hidden=false;document.body.classList.add('cloud-app-open');
     state.files=Array.from({length:90},(_,i)=>({id:i+1,name:'長いファイル名の表示テスト '+i+' あいうえお.mp4',mediaKind:'video',mimeType:'video/mp4',cryptoVersion:1,sizeBytes:1200,createdAt:'2026-09-01 12:00:00'}));
     document.querySelector('#content-grid').replaceChildren(...state.files.map(fileCard));};`);
  }
  res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.wasm':'application/wasm'})[extname(path)]||'application/octet-stream');res.end(data);
 }catch(e){res.writeHead(500).end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
mkdirSync(resolve(root,'tmp/mobile-ui'),{recursive:true});
const engines=[['webkit',webkit,{}],['chromium',chromium,{executablePath:['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)}]];
try {
 for(const [name,engine,launch] of engines) {
  const browser=await engine.launch({headless:true,...launch});
  try {
   for(const standalone of [false,true]) {
    const context=await browser.newContext({...devices[name==='webkit'?'iPhone 13':'Pixel 7'],viewport:{width:390,height:740}});
    if(standalone) await context.addInitScript(()=>{Object.defineProperty(navigator,'standalone',{value:true});const match=window.matchMedia.bind(window);window.matchMedia=q=>q==='(display-mode: standalone)'?{...match(q),matches:true,addEventListener(){}}:match(q);});
    if(standalone)await context.addCookies([{name:'ui-standalone',value:'1',url:origin}]);
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/cloud/');await page.waitForFunction(()=>globalThis.__ui);await page.evaluate(()=>__show());
    const baseline=await page.evaluate(()=>{const nav=document.querySelector('.mobile-nav'),text=document.querySelector('.file-copy strong');return {color:getComputedStyle(text).color,ink:getComputedStyle(document.documentElement).color,navPosition:getComputedStyle(nav).position,invalidCss:[...document.styleSheets].flatMap(s=>[...s.cssRules]).some(r=>r.selectorText==='.troom-passkey-account-dialog'),svg:!!nav.querySelector('svg')};});
    const broken=await page.evaluate(async()=>{const stage=document.querySelector('.thumb');await __ui.installThumbnailBlob(__ui.state.files[0],stage,new Blob(['invalid-image'],{type:'image/webp'}));await new Promise(r=>setTimeout(r,120));return !!stage.querySelector('img')&&!stage.querySelector('img').naturalWidth;});
    if(before) {assert.equal(broken,true);assert.equal(baseline.svg,false);assert.equal(baseline.invalidCss,false);console.log('BEFORE',name,{standalone,...baseline,broken});}
    else {
     assert.equal(broken,false,'decoding failure must retain the fallback');assert.equal(baseline.color,baseline.ink);assert.equal(baseline.svg,true);assert.equal(baseline.invalidCss,true);
     // Footer is a row outside the scroll area, through viewport/keyboard-size changes.
     for(const size of [{width:390,height:740},{width:390,height:590},{width:390,height:360},{width:740,height:390},{width:320,height:568}]) {
      await page.setViewportSize(size);
      await page.evaluate(()=>document.querySelector('.workspace').scrollTop=1200);
      const layout=await page.evaluate(()=>{const w=document.querySelector('.workspace'),n=document.querySelector('.mobile-nav'),g=document.querySelector('#content-grid'),r=n.getBoundingClientRect();return {bottom:r.bottom,top:r.top,workBottom:w.getBoundingClientRect().bottom,scrolled:w.scrollTop,outerScroll:scrollY,overflow:document.documentElement.scrollWidth>innerWidth,columns:getComputedStyle(g).gridTemplateColumns.split(' ').length};});
      assert.ok(Math.abs(layout.bottom-size.height)<2,JSON.stringify(layout));assert.equal(layout.workBottom,layout.top);assert.ok(layout.scrolled>0);assert.equal(layout.outerScroll,0);assert.equal(layout.overflow,false);assert.equal(layout.columns,2);
     }
     await page.setViewportSize({width:390,height:740});
     const restored=await page.evaluate(async()=>{
      const w=document.querySelector('.workspace');w.scrollTop=780;__ui.rememberCurrentNavigationPosition('file',5);const entry=history.state;
      __ui.resetFolderScrollPosition();await __ui.restoreNavigationPosition(entry);await new Promise(r=>setTimeout(r,120));return {entry:entry.scrollY,actual:w.scrollTop};
     });assert.equal(restored.actual,restored.entry);assert.equal(restored.entry,780);
     // Actual IndexedDB + actual AES thumbnail encryption/decryption, never a production key.
     const thumbnails=await page.evaluate(async()=>{
      const png=new Uint8Array(await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=')).arrayBuffer());
      const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
      const encrypted=await TRoomCrypto.encryptThumbnail(new Blob([png],{type:'image/png'}),key);
      const file={...__ui.state.files[0],mediaKind:'image',hasThumbnail:true,hasDisplayThumbnail:true,fileKey:key};
      const stage=document.querySelector('.thumb'),scope=__ui.displayCacheScope(),version=file.createdAt;
      const load=()=>__ui.loadEncryptedThumbnail(file,stage,new AbortController().signal,__ui.state.thumbnailLoadGeneration);
      const saved=TCloudSession;let requests=[];let mode='recover';
      globalThis.TCloudSession={check(){},async fetch(url){requests.push(url);if(mode==='denied') return new Response('',{status:403});if(mode==='fail')return new Response('',{status:503});if(url.endsWith('display-thumbnail'))return new Response('invalid',{headers:{'Content-Type':'image/webp'}});return new Response(encrypted);}};
      try {
       await TCloudDisplayCache.putThumbnail(scope,file.id,version,new Blob(['corrupt'],{type:'image/webp'}));
       await TCloudDisplayCache.putThumbnail('unrelated-scope',file.id,version,new Blob(['preserve']));
       await load();const recovered=stage.querySelector('img')?.naturalWidth===1;
       const recoveredRequests=requests.length;requests=[];await load();const cacheRequests=requests.length;
       await TCloudDisplayCache.removeThumbnail(scope,file.id,version);mode='denied';requests=[];await load();const deniedRequests=requests.length;
       mode='fail';requests=[];await load();const failedRequests=requests.length;
       const preserved=await (await TCloudDisplayCache.getThumbnail('unrelated-scope',file.id,version)).text();
       // A delayed valid response from a departed folder must never install an image.
       let release;globalThis.TCloudSession.fetch=async()=>new Promise(r=>{release=r;});
       const pending=load();while(!release)await new Promise(r=>setTimeout(r,10));__ui.resetEncryptedThumbnailLoading();stage.innerHTML='<span>fallback</span>';release(new Response(png));await pending;
       return {recovered,recoveredRequests,cacheRequests,deniedRequests,failedRequests,preserved,staleImage:!!stage.querySelector('img')};
      }finally {globalThis.TCloudSession=saved;}
     });
     // One queue attempt per source; the scheduler owns bounded backoff retries.
     assert.deepEqual(thumbnails,{recovered:true,recoveredRequests:2,cacheRequests:0,deniedRequests:1,failedRequests:2,preserved:'preserve',staleImage:false});
     const formats=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);const results=[];for(const type of ['image/png','image/jpeg','image/webp']){const blob=await new Promise(r=>canvas.toBlob(r,type));const decoded=await TCloudUI.decodeThumbnail(blob);results.push({requested:type,actual:blob.type,width:decoded.image.naturalWidth});URL.revokeObjectURL(decoded.url);}return results;});
     for(const format of formats)assert.equal(format.width,16,JSON.stringify(format));
     await page.evaluate(()=>__ui.resetFolderScrollPosition());
     const dialogs=await page.evaluate(()=>{const d=document.querySelector('#folder-dialog');d.showModal();const rect=d.getBoundingClientRect();const font=getComputedStyle(d.querySelector('input')).fontSize;d.close();return {top:rect.top,bottom:rect.bottom,font};});assert.ok(dialogs.top>=0&&dialogs.bottom<=740);assert.equal(dialogs.font,'16px');
     console.log('PASS mobile UI',name,{standalone,viewportChanges:5,history:restored,thumbnails});
    }
    await page.screenshot({path:resolve(root,`tmp/mobile-ui/${before?'before':'after'}-${name}-${standalone}.png`),fullPage:false});
    assert.deepEqual(errors,[]);await context.close();
   }
   const desktop=await browser.newPage({viewport:{width:1280,height:900}});
   await desktop.goto(origin+'/cloud/');await desktop.waitForFunction(()=>globalThis.__ui);await desktop.evaluate(()=>{__show();__ui.bindEvents();scrollTo(0,900);});
   const desktopLayout=await desktop.evaluate(()=>({scroll:scrollY,nav:getComputedStyle(document.querySelector('.mobile-nav')).display,columns:getComputedStyle(document.querySelector('#content-grid')).gridTemplateColumns.split(' ').length}));
   assert.equal(desktopLayout.nav,'none');assert.equal(desktopLayout.scroll,900);assert.ok(desktopLayout.columns>2);
   await desktop.evaluate(()=>__ui.resetFolderScrollPosition());
   await desktop.locator('.file-select-button').first().click();assert.equal(await desktop.locator('.file-card.selected').count(),1);
   await desktop.evaluate(()=>__ui.clearFileSelection(true,false));await desktop.locator('#display-toggle').click();assert.equal(await desktop.locator('#content-grid').evaluate(e=>e.classList.contains('list-mode')),true);
   const updateBlocks=await desktop.evaluate(()=>['uploading','activeFolderUploadOperationId','downloadActive','offlineActive','pendingSafetyUpload','filePickerActive'].map(key=>{const saved=__ui.state[key];__ui.state[key]=true;const event=new Event('troom:before-auto-update',{cancelable:true});document.dispatchEvent(event);__ui.state[key]=saved;return [key,event.defaultPrevented];}));
   for(const [key,blocked] of updateBlocks)assert.equal(blocked,true,'auto update must defer during '+key);
   console.log('PASS desktop selection, view mode and document scrolling',name);await desktop.close();
  } finally {await browser.close();}
 }
} finally {server.closeAllConnections();server.close();}
