import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {createStore} from '../../e2ee/store.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {photoHeader} from '../../e2ee/photo-crypto.mjs';

const f=await systemFixture(),user=f.users['main-admin'],trust=await publicTrustPackage(f.configuration);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const root=resolve(fileURLToPath(new URL('../../public/',import.meta.url))),errors=[],requests=[];
let origin;
const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,origin);
  if(url.pathname.startsWith('/diary/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    requests.push({path:url.pathname,method:req.method});
    const response=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),f.env,f.ctx);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(url.pathname.startsWith('/security/')||url.pathname==='/assets/pwa-auto-update.js'){res.setHeader('Content-Type','text/javascript');res.end('');return;}
  const path=resolve(root,url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length));
  if(!path.startsWith(root+sep)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',['.mjs','.js'].includes(extname(path))?'text/javascript':extname(path)==='.html'?'text/html':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));
}catch(e){errors.push(e.message);res.writeHead(500);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
const call=async(path,body)=>{
  const r=await f.worker.fetch(new Request(origin+'/diary/api/encryption'+path,{method:body?'POST':'GET',headers:{Cookie:f.cookie(),...(body?{Origin:origin,'X-Diary-Request':'1','Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,f.ctx);const v=await r.json();assert.equal(r.status,200);return v;
};
const {profile}=await call('/profile');const writer=new EncryptedDiaryClient({profile,anchor:trust.anchor,transport:{valid:async()=>true,timestamp:async()=>new Date().toISOString(),snapshot:(h,s)=>readSnapshotPages(o=>call('/snapshot?'+new URLSearchParams(Object.entries(o).filter(([,v])=>v!=null))),h,s),mutation:(proposal,operation)=>call('/mutation',{proposal,operation})}});
await writer.unlock(new Uint8Array(user.prf));await writer.sync();
const legacyRegistry = {};
function seedLegacyPhoto(fileName) {
  const id = crypto.randomUUID();
  const kinds = ['original', 'display', 'thumbnail'];
  const keys = kinds.map(kind => `legacy/${id}/${kind}`);
  for (const key of keys) f.r2.set(key, { bytes: new Uint8Array(png) });
  f.db.sqlite.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, writer.household, 'main-admin', 'migration', 'attached', ...keys, '{}', 1, 'legacy', Date.now() + 86400000, null);
  legacyRegistry[id] = { household: writer.household, accountId: 'main-admin' };
  const urls = Object.fromEntries(kinds.map(kind => [`${kind}Url`, `/diary/api/photos/${id}/${kind}`]));
  return { id, fileName, contentType: 'image/png', originalSize: png.length, width: 1, height: 1, ...urls };
}
const old = seedLegacyPhoto('legacy.png'), oldId = old.id;
const store=createStore(f.db,{households:writer.directory.households,epochs:writer.directory.epochs,directory:writer.directory,photos:legacyRegistry});writer.transport.mutation=(p,o)=>store.mutation(writer.actor,p,o);
const entry=await writer.commitAction('seed',{entryDate:'2026-11-18',title:'Mixed photos',content:`[[写真:${oldId}]]\n${'Scroll position fixture\n'.repeat(45)}`,tags:[],photos:[old]},{state:'published'});
const browser=await chromium.launch({headless:true});
try{
  const desktop=process.argv.includes('--desktop');
  const context=await browser.newContext({viewport:{width:desktop?1280:390,height:844},isMobile:!desktop,hasTouch:!desktop,acceptDownloads:true});
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(({prf,credentialId,trust})=>{window.TRoomPasskeys={authenticate:async()=>({credentialId,prfOutput:new Uint8Array(prf),verified:{diaryTrust:trust},link:{accountId:'main-admin'},handoff:{handoffToken:'main-admin',diaryTrust:trust}})};},{prf:[...user.prf],credentialId:user.credentialId,trust});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/diary/');await page.click('#passkey-login');await page.locator('#app-view').waitFor({state:'visible'});
  await page.locator(`#entry-list [data-entry-id="${entry.id}"]`).click();await page.click('#edit-entry-button');
  await page.locator('#editor-photo-list img').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>[...document.querySelectorAll('#editor-photo-list img')].every(i=>i.naturalWidth>0));
  const chooser=page.waitForEvent('filechooser');await page.click('#add-photo-button');await (await chooser).setFiles([{name:'new-private.png',mimeType:'image/png',buffer:png}]);
  await page.waitForFunction(()=>!document.querySelector('#photo-input').disabled);await page.click('#save-entry-button');await page.locator('#editor-dialog').waitFor({state:'hidden'});
  const newId=f.db.sqlite.prepare('SELECT id FROM diary_e2ee_media WHERE id!=? AND status=\'attached\'').get(oldId).id;
  const row=f.db.sqlite.prepare('SELECT original_key FROM diary_e2ee_media WHERE id=?').get(newId);assert.ok(photoHeader(f.r2.get(row.original_key).bytes));assert.equal(f.r2.size,6);
  for(const kind of ['original','display','thumbnail'])assert.deepEqual(Buffer.from(f.r2.get(`legacy/${oldId}/${kind}`).bytes),png);
  let releaseThumb, releaseDisplay, thumbRequested, displayRequested;
  const thumbnailGate = new Promise(resolve => { releaseThumb = resolve; });
  const displayGate = new Promise(resolve => { releaseDisplay = resolve; });
  const thumbnailRequest = new Promise(resolve => { thumbRequested = resolve; });
  const displayRequest = new Promise(resolve => { displayRequested = resolve; });
  await page.route(`**/api/photos/${newId}/thumbnail`, async route => {
    thumbRequested();
    await thumbnailGate;
    await route.continue();
  }, {times:1});
  await page.route(`**/api/photos/${newId}/display`, async route => {
    displayRequested();
    await displayGate;
    await route.continue();
  }, {times:1});
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});await page.locator(`#entry-list [data-entry-id="${entry.id}"]`).click();
  const frame = page.locator('#entry-dialog[open] .entry-photo-frame').last();
  const layout = () => frame.evaluate(async element => {
    await new Promise(requestAnimationFrame);
    const dialog = element.closest('dialog');
    const {height, top} = element.getBoundingClientRect();
    return {height, top, scrollTop:dialog.scrollTop, scrollHeight:dialog.scrollHeight};
  });
  try {
    await frame.scrollIntoViewIfNeeded();
    const waitForRequest = (request, label) => Promise.race([request,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label)), 8000).unref())]);
    await waitForRequest(thumbnailRequest, 'visible photo did not request its thumbnail');
    const initial = await layout();
    assert.ok(initial.height > 100 && initial.scrollTop > 0);
    assert.equal(await frame.locator('.diary-photo-placeholder').isVisible(), true);
    assert.equal(await frame.locator('.entry-photo-display').getAttribute('src'), null);
    releaseThumb();
    await waitForRequest(displayRequest, 'thumbnail did not trigger the display variant');
    await frame.locator('.entry-photo[data-photo-state="ready"]').waitFor();
    assert.equal(await frame.locator('.diary-photo-placeholder').isVisible(), false);
    assert.deepEqual(await layout(), initial, 'thumbnail must keep the initial scroll geometry');
    releaseDisplay();
    await frame.locator('.entry-photo-display[data-photo-state="ready"]').waitFor();
    assert.deepEqual(await layout(), initial, 'the display variant must also keep the initial scroll geometry');
  } finally {
    releaseThumb();
    releaseDisplay();
  }
  const images=page.locator('#detail-content .entry-photo');await images.last().click();
  await page.waitForFunction(()=>document.querySelector('#photo-viewer-image').naturalWidth>0&&document.querySelector('#photo-viewer-status').hidden);
  const event=page.waitForEvent('download');await page.click('#photo-download-original');const download=await event;
  const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),png);assert.equal(download.suggestedFilename(),'new-private.png');
  await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('#photo-viewer-file').textContent.includes('legacy.png')&&document.querySelector('#photo-viewer-status').hidden);
  const legacyDownload=page.waitForEvent('download');await page.click('#photo-download-original');const oldDownload=await legacyDownload;const oldChunks=[];for await(const chunk of await oldDownload.createReadStream())oldChunks.push(chunk);assert.deepEqual(Buffer.concat(oldChunks),png);
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#photo-viewer-file').textContent.includes('new-private.png')&&document.querySelector('#photo-viewer-status').hidden);
  assert.ok(requests.filter(r=>r.path===`/diary/api/photos/${newId}/display`).length<=2,'detail and viewer reuse the decoded blob after reload');
  await page.keyboard.press('Escape');await page.locator('#photo-viewer-dialog').waitFor({state:'hidden'});
  await page.keyboard.press('Escape');await page.locator('#entry-dialog').waitFor({state:'hidden'});
  await page.click('#camera-roll-button');
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('#camera-roll-grid img')];return images.length===2&&images.every(i=>i.naturalWidth>0);});
  await page.keyboard.press('Escape');
  await page.locator('#camera-roll-dialog').waitFor({ state: 'hidden' });
  // The same image loader: near-viewport prefetch, concurrency and stale DOM protection.
  const bounds=await page.evaluate(async()=>{
    const {createPhotoImages}=await import('/diary/diary-photo-images.js');
    let running=0,max=0,reads=0;const done=[];
    const loader=createPhotoImages({readPhoto:async()=>{reads++;max=Math.max(max,++running);await new Promise(r=>done.push(r));running--;return new Blob(['synthetic'],{type:'image/png'});}});
    const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;overflow:auto;z-index:99999;background:white';document.body.append(host);
    for(let n=0;n<40;n++){const image=document.createElement('img');image.style.cssText='display:block;width:200px;height:500px';host.append(image);loader.bind(image,{id:String(n)},'thumbnail',{root:host});}
    const deadline = performance.now() + 5000;
    while (!reads && performance.now() < deadline) await new Promise(requestAnimationFrame);
    const first=reads;loader.reset();for(const resolve of done)resolve();await new Promise(requestAnimationFrame);const stale=host.querySelectorAll('img[src]').length;host.remove();return {max,first,stale};
  });
  assert.ok(bounds.first>0&&bounds.first<40);assert.ok(bounds.max<=4);assert.equal(bounds.stale,0);
  await page.click('#logout-button');await page.locator('#login-view').waitFor({state:'visible'});
  assert.equal(await page.locator('img[src^="blob:"]').count(),0,'logout releases plaintext object URLs');
  await page.click('#passkey-login');await page.locator('#app-view').waitFor({state:'visible'});
  let releaseAlbumThumbnail;
  const albumThumbnailGate = new Promise(resolve => { releaseAlbumThumbnail = resolve; });
  const firstAlbumRequest = requests.length;
  await page.route(`**/api/photos/${newId}/thumbnail`, async route => {
    await albumThumbnailGate;
    await route.continue();
  }, {times:1});
  try {
    await page.click('#camera-roll-button');
    const tile = page.locator(`#camera-roll-grid [data-photo-id="${newId}"]`);
    const placeholder = tile.locator('.diary-photo-placeholder');
    await placeholder.waitFor({state:'visible'});
    assert.equal(await placeholder.evaluate(element => getComputedStyle(element,'::before').content), '"写真を読み込み中…"');
    releaseAlbumThumbnail();
    await tile.locator('img[data-photo-state="ready"]').waitFor();
    await placeholder.waitFor({state:'hidden'});
    assert.equal(requests.slice(firstAlbumRequest).some(({path}) => path.endsWith('/display')), false);
  } finally {
    releaseAlbumThumbnail();
  }
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('#camera-roll-grid img')];return images.length===2&&images.every(i=>i.naturalWidth>0);});
  if (!desktop) {
    const album = page.locator('#camera-roll-dialog');
    await page.click('[data-close-dialog="camera-roll-dialog"]');
    await album.waitFor({ state: 'hidden' });
    const photos = Array.from({ length: 24 }, (_, index) => seedLegacyPhoto(`album-${index}.png`));
    await writer.sync();
    await writer.commitAction('seed-album-prefetch', {
      entryDate: '2026-11-17', title: 'Album scroll fixture', tags: [], photos,
      content: photos.map(({ id }) => `[[写真:${id}]]`).join('\n')
    }, { state: 'published' });
    await page.click('#camera-roll-button');
    await page.waitForFunction(() => document.querySelectorAll('#camera-roll-grid img').length === 26);
    const { near, far } = await album.evaluate(dialog => {
      const { bottom } = dialog.getBoundingClientRect();
      const cards = [...dialog.querySelectorAll('.camera-roll-item')].map(card => ({
        id: card.dataset.photoId,
        distance: card.querySelector('img').getBoundingClientRect().top - bottom
      }));
      return {
        near: cards.findLast(({ distance }) => distance > 50 && distance < 680)?.id,
        far: cards.find(({ distance }) => distance > 760)?.id
      };
    });
    assert.ok(near && far, 'the album contains offscreen photos inside and beyond the 720px margin');
    const loaded = id => album.locator(`[data-photo-id="${id}"] img[src^="blob:"]`);
    await loaded(near).waitFor({ state: 'attached', timeout: 8000 });
    assert.equal(await album.evaluate(dialog => dialog.scrollTop), 0, 'a nearby thumbnail loads before scrolling');
    assert.equal(requests.some(({ path }) => path === `/diary/api/photos/${far}/thumbnail`), false, 'distant thumbnails are deferred');
    await album.locator(`[data-photo-id="${far}"]`).scrollIntoViewIfNeeded();
    await loaded(far).waitFor({ state: 'attached' });
    console.log('Album prefetch: the scrolling dialog loads nearby thumbnails before scrolling and defers distant ones.');
  }
  assert.deepEqual(errors,[]);await context.close();
  console.log('Mixed photo browser: existing plaintext + new encrypted photos survive edit/reload, decode in detail/viewer, save exact original bytes; bounded near-viewport prefetch and reset reject late results.');
}finally{writer.lock();await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}
