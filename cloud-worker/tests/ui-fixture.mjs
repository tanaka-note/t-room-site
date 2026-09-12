import {createServer} from 'node:http';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const {chromium, webkit, devices} = createRequire(new URL('../../diary-worker/package.json', import.meta.url))('playwright');
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const engines = [['chromium', chromium, {executablePath: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)}], ['webkit', webkit, {}]];
export async function startUIFixture(sourceRoot = root) {
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/cloud/')) { res.setHeader('Content-Type', 'text/javascript'); res.end(''); return; }
      const path = url.pathname === '/cloud/' ? 'index.html' : /^\/cloud\/share\//.test(url.pathname) ? 'share.html' : url.pathname.slice(7);
      if (path.includes('..')) { res.writeHead(404).end(); return; }
      let data = readFileSync(resolve(sourceRoot, 'cloud-worker/public', path));
      if (path.endsWith('.css') && req.headers.cookie?.includes('standalone=1')) data = Buffer.from(data.toString().replaceAll('@media (display-mode: standalone)', '@media all'));
      if (path === 'cloud.js') data = Buffer.from(data.toString().replace('document.addEventListener("DOMContentLoaded", initialize);', '') + `
        globalThis.__test = {state, bindEvents, fileCard, renderItems, loadItems, loadNextItemPage, hydrateFileRecords, hydrateFolderRecords, chooseVideoThumbnailFrame, captureNativeVideoThumbnail, backfillVideoThumbnail, displayCacheScope, scheduleDisplayListingCacheWrite, scheduleEncryptedThumbnailLoading, resetEncryptedThumbnailLoading, loadEncryptedThumbnail, installThumbnailBlob, openPreview, handleHistoryNavigation, appScrollPosition, scrollAppTo, resetFolderScrollPosition, releaseSessionState,
          searchCacheSnapshot() { return [...searchMetadataCache.values()]; },
          unavailableVideo() { registerMediaWithDeviceCache = async () => { throw new Error('Local unavailable-media fixture'); }; },
          videoFixture(url) { registerMediaWithDeviceCache = async () => ({token:'local-video-fixture',url}); },
          photoFixture() { prepareDeviceCacheEntry = async () => {}; globalThis.TCloudMedia = {...TCloudMedia, decryptToBlob: async () => __thumb.blob}; },
          prepare(count) {
            resetEncryptedThumbnailLoading();
            state.session={role:'admin',serviceAccountId:'admin',sessionCacheId:'fixture',canDelete:true,canEditFiles:true};
            state.credentialSalt='fixture';state.folderId=null;state.historyReady=true;state.itemRenderLimit=count;state.view='all';
            state.files=Array.from({length:count},(_,i)=>({id:i+1,name:'fixture '+i,mediaKind:i%2?'video':'image',mimeType:i%2?'video/mp4':'image/png',hasThumbnail:true,cryptoVersion:1,createdAt:'2026-09-12 00:00:00',sizeBytes:100}));
            document.querySelector('#boot-view').hidden=true;document.querySelector('#login-view').hidden=true;document.querySelector('#app-view').hidden=false;document.body.classList.add('cloud-app-open');
            document.querySelector('#content-grid').replaceChildren(...state.files.map(fileCard));
            history.replaceState({tcloud:true,folderId:null,folderName:'fixture',previewId:null},'',location.href);
          }
        };
      `);
      if (path === 'share.js') data = Buffer.from(data.toString().replace('document.addEventListener("DOMContentLoaded", initialize);', '') + `
        globalThis.__share = {state, bindEvents, renderItems, renderSortedItems, changeSharedSort, openPreview, loadItems,
          videoFixture(url) { globalThis.TCloudMedia = {...TCloudMedia, registerMedia:async () => ({token:'local-video',url})}; },
          prepare(files) {
            state.info={expiresAt:Math.floor(Date.now()/1000)+3600}; state.targetType='selection';
            state.files=files;state.folderId=null;state.historyReady=true;
            document.querySelector('#unlock-view').hidden=true;document.querySelector('#browser-view').hidden=false;
            document.querySelector('#share-toolbar').hidden=false;
            history.replaceState({tcloudShare:true,folderId:null,previewId:null},'',location.href);
          }
        };
      `);
      res.setHeader('Content-Type', ({'.html':'text/html','.css':'text/css','.js':'text/javascript','.wasm':'application/wasm'})[extname(path)] || 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {origin:`http://127.0.0.1:${server.address().port}`, close:()=>new Promise(r=>server.close(r))};
}

export async function preparePage(page, origin, count = 128) {
  await page.goto(origin + '/cloud/');
  await page.waitForFunction(() => globalThis.__test);
  await page.evaluate(async count => {
    __test.prepare(count);
    globalThis.TCloudSession = {check:()=>({sessionCacheId:__test.state.session?.sessionCacheId}), fetch:globalThis.fetch.bind(globalThis), scopedUrl:url=>url};
    __test.bindEvents();
    const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;canvas.getContext('2d').fillStyle='#248080';canvas.getContext('2d').fillRect(0,0,64,64);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    globalThis.__thumb = {blob,key,encrypted:await TRoomCrypto.encryptThumbnail(blob,key)};
    __test.state.files.forEach(file=>file.fileKey=key);
  }, count);
}

export async function makeVideoFixture(origin, options = {}) {
  const [,engine,launch]=engines[0];
  const browser=await engine.launch({headless:true,...launch});
  try {
    const page=await browser.newPage();await page.goto(origin+'/empty');
    return await page.evaluate(async(options)=>{
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
      const context=canvas.getContext('2d'),stream=canvas.captureStream(10);
      const type=['video/webm;codecs=vp8','video/mp4;codecs=avc1.42001E'].find(t=>MediaRecorder.isTypeSupported(t));
      const recorder=new MediaRecorder(stream,{mimeType:type}),chunks=[];
      recorder.ondataavailable=e=>chunks.push(e.data);
      const done=new Promise(r=>recorder.onstop=r);recorder.start();
      const start=performance.now();let frame=0;const timer=setInterval(()=>{context.fillStyle=performance.now()-start<(options.darkIntroMs||0)?'#000':frame++%2?'#248080':'#804020';context.fillRect(0,0,160,90);},100);
      await new Promise(r=>setTimeout(r,options.durationMs||1200));recorder.stop();clearInterval(timer);await done;stream.getTracks().forEach(t=>t.stop());
      const blob=new Blob(chunks,{type});return {type,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
    },options);
  } finally {await browser.close();}
}
