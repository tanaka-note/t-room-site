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
const oldId=crypto.randomUUID(),old={id:oldId,fileName:'legacy.png',contentType:'image/png',originalSize:png.length,width:1,height:1,originalUrl:`/diary/api/photos/${oldId}/original`,displayUrl:`/diary/api/photos/${oldId}/display`,thumbnailUrl:`/diary/api/photos/${oldId}/thumbnail`};
for(const kind of ['original','display','thumbnail'])f.r2.set('legacy/'+kind,{bytes:new Uint8Array(png)});
f.db.sqlite.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(oldId,writer.household,'main-admin','migration','attached','legacy/original','legacy/display','legacy/thumbnail','{}',1,'legacy',Date.now()+86400000,null);
const store=createStore(f.db,{households:writer.directory.households,epochs:writer.directory.epochs,directory:writer.directory,photos:{[oldId]:{household:writer.household,accountId:'main-admin'}}});writer.transport.mutation=(p,o)=>store.mutation(writer.actor,p,o);
const entry=await writer.commitAction('seed',{entryDate:'2026-11-18',title:'Mixed photos',content:`[[写真:${oldId}]]`,tags:[],photos:[old]},{state:'published'});writer.lock();
const browser=await chromium.launch({headless:true});
try{
  const desktop=process.argv.includes('--desktop');
  const context=await browser.newContext({viewport:{width:desktop?1280:390,height:844},isMobile:!desktop,hasTouch:!desktop,acceptDownloads:true});
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
  for(const kind of ['original','display','thumbnail'])assert.deepEqual(Buffer.from(f.r2.get('legacy/'+kind).bytes),png);
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});await page.locator(`#entry-list [data-entry-id="${entry.id}"]`).click();
  await page.waitForFunction(()=>{const a=[...document.querySelectorAll('#detail-content .entry-photo')];return a.length===2&&a.every(i=>i.naturalWidth>0);});
  const images=page.locator('#detail-content .entry-photo');await images.last().click();
  await page.waitForFunction(()=>document.querySelector('#photo-viewer-image').naturalWidth>0&&document.querySelector('#photo-viewer-status').hidden);
  const event=page.waitForEvent('download');await page.click('#photo-download-original');const download=await event;
  const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),png);assert.equal(download.suggestedFilename(),'new-private.png');
  await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('#photo-viewer-file').textContent.includes('legacy.png')&&document.querySelector('#photo-viewer-status').hidden);
  const legacyDownload=page.waitForEvent('download');await page.click('#photo-download-original');const oldDownload=await legacyDownload;const oldChunks=[];for await(const chunk of await oldDownload.createReadStream())oldChunks.push(chunk);assert.deepEqual(Buffer.concat(oldChunks),png);
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('#photo-viewer-file').textContent.includes('new-private.png')&&document.querySelector('#photo-viewer-status').hidden);
  assert.ok(requests.filter(r=>r.path===`/diary/api/photos/${newId}/display`).length<=2,'detail and viewer reuse the decoded blob after reload');
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
  await page.click('#camera-roll-button');
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('#camera-roll-grid img')];return images.length===2&&images.every(i=>i.naturalWidth>0);});
  await page.keyboard.press('Escape');
  // The same image loader: near-viewport prefetch, concurrency and stale DOM protection.
  const bounds=await page.evaluate(async()=>{
    const {createPhotoImages}=await import('/diary/diary-photo-images.js');
    let running=0,max=0,reads=0;const done=[];
    const loader=createPhotoImages({readPhoto:async()=>{reads++;max=Math.max(max,++running);await new Promise(r=>done.push(r));running--;return new Blob(['synthetic'],{type:'image/png'});}});
    const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;overflow:auto;z-index:99999;background:white';document.body.append(host);
    for(let n=0;n<40;n++){const image=document.createElement('img');image.style.cssText='display:block;width:200px;height:500px';host.append(image);loader.bind(image,{id:String(n)},'thumbnail');}
    await new Promise(r=>setTimeout(r,150));const first=reads;loader.reset();for(const resolve of done)resolve();await new Promise(r=>setTimeout(r,50));const stale=host.querySelectorAll('img[src]').length;host.remove();return {max,first,stale};
  });
  assert.ok(bounds.first>0&&bounds.first<40);assert.ok(bounds.max<=4);assert.equal(bounds.stale,0);
  await page.click('#logout-button');await page.locator('#login-view').waitFor({state:'visible'});
  assert.equal(await page.locator('img[src^="blob:"]').count(),0,'logout releases plaintext object URLs');
  await page.click('#passkey-login');await page.locator('#app-view').waitFor({state:'visible'});
  await page.click('#camera-roll-button');
  await page.waitForFunction(()=>{const images=[...document.querySelectorAll('#camera-roll-grid img')];return images.length===2&&images.every(i=>i.naturalWidth>0);});
  assert.deepEqual(errors,[]);await context.close();
  console.log('Mixed photo browser: existing plaintext + new encrypted photos survive edit/reload, decode in detail/viewer, save exact original bytes; bounded near-viewport prefetch and reset reject late results.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}
