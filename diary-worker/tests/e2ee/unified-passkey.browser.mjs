import {photoHeader} from '../../e2ee/photo-crypto.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,writeFile,utimes,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,extname,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,devices} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {entry} from './fixture.mjs';
import {verifyCacheBudget,inspectLogoutStorage,waitForPreparedIndex} from './cache-browser-fixture.mjs';

const account = process.argv.includes('--owner') ? 'main-admin' : process.argv.includes('--independent-editor') ? 'chiharu-admin' : 'main-user';
const f=await systemFixture(),user=f.users[account],root=resolve(fileURLToPath(new URL('../../public/',import.meta.url)));
const wire=[],errors=[];let origin,authentications=0;
const trust=await publicTrustPackage(f.configuration);
const progressive=process.argv.includes('--progressive');let bodyIV,summaryIV,holdSnapshot=progressive,releaseSnapshot;
const photoSelection=process.argv.includes('--photo-selection');
const workerd=process.argv.includes('--workerd')?await(await import('./workerd-response.mjs')).workerdResponseTransport():null;
let compressedSnapshots=0;
const progressiveEntries=workerd?73:48;
let photoDirectory;const photoPaths=[];
const originalPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
let snapshotStarted;const snapshotRequested=new Promise(resolve=>{snapshotStarted=resolve;});
if(progressive) {
  const request=async(path,body)=>{
    const response=await f.worker.fetch(new Request(f.env.DIARY_ENCRYPTION_ORIGIN+'/diary/api/encryption'+path,{method:body?'POST':'GET',headers:{Cookie:f.cookie(user.serviceAccountId),...(body?{Origin:f.env.DIARY_ENCRYPTION_ORIGIN,'X-Diary-Request':'1','Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,f.ctx);
    const value=await response.json();assert.equal(response.status,200);return value;
  };
  const initial=await request('/profile'),writer=new EncryptedDiaryClient({profile:initial.profile,anchor:trust.anchor,documentFormat:2,transport:{valid:async()=>true,snapshot:(h,since)=>readSnapshotPages(options=>request('/snapshot?'+new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))),h,since),mutation:(proposal,operation)=>request('/mutation',{proposal,operation})}});
  await writer.unlock(new Uint8Array(user.prf));
  for(let i=0;i<progressiveEntries;i++)await writer.commit(entry({entryDate:new Date(Date.now()-(progressiveEntries-1-i)*86400000).toISOString().slice(0,10),title:`Synthetic seed ${i}`,content:i===0?'OLDEST_BROWSER_CANARY':'Synthetic body '+i,photos:[]}),{id:String(i+1)},{refresh:false});
  bodyIV=writer.records.get('1').row.envelope.iv;summaryIV=writer.records.get('1').row.summary.iv;writer.lock();
}
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/diary/api/')) {
      if(holdSnapshot&&url.pathname==='/diary/api/encryption/snapshot'){
        holdSnapshot=false;
        await new Promise(resolve=>{releaseSnapshot=resolve;snapshotStarted();});
        if (res.destroyed) return;
      }
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      wire.push({path:url.pathname,method:req.method,body:body.toString(),...(url.pathname==='/diary/api/encryption/snapshot'?{snapshotSince:Number(url.searchParams.get('since'))}:{})});
      const reply=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )}),f.env,f.ctx);
      if(workerd){if(url.pathname==='/diary/api/encryption/snapshot'&&reply.headers.get('Content-Encoding')==='gzip')compressedSnapshots++;await workerd.send(reply,res);return;}
      res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end(Buffer.from(await reply.arrayBuffer()));return;
    }
    if(['/security/passkey-client.js','/assets/pwa-auto-update.js'].includes(url.pathname)){res.setHeader('Content-Type','text/javascript');res.end('/* Synthetic authentication, no production calls. */');return;}
    const file=resolve(root,url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length));
    if(!url.pathname.startsWith('/diary/')||!file.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',['.js','.mjs'].includes(extname(file))?'text/javascript':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(file));
  }catch(error){
    if(res.destroyed)return;
    errors.push(error.name);
    if(res.headersSent)res.destroy();
    else{res.writeHead(500);res.end();}
  }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
const browser=await chromium.launch({headless:true,executablePath:process.env.TROOM_CHROMIUM_EXECUTABLE});
async function pageFor(context) {
  await context.exposeBinding('fixtureAuthentication',()=>{authentications++;});
  await context.addInitScript(({prf,credentialId,trust,accountId})=>{window.TRoomPasskeys={authenticate:async()=>{await window.fixtureAuthentication();window.lastPRF=new Uint8Array(prf);return {credentialId,prfOutput:window.lastPRF,verified:{diaryTrust:trust},link:{accountId},handoff:{handoffToken:accountId,diaryTrust:trust}};}};},{prf:[...user.prf],credentialId:user.credentialId,trust,accountId:user.serviceAccountId});
  if(progressive)await context.addInitScript(({iv,summaryIV})=>{
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      const timer = originalSetTimeout(callback, delay, ...args);
      if (delay === 45_000) window.expireDiaryRead = () => {
        window.clearTimeout(timer);
        callback(...args);
      };
      return timer;
    };
    const native=crypto.subtle.decrypt.bind(crypto.subtle);let release;
    const gate=new Promise(resolve=>{release=resolve;});window.releaseOldBody=release;window.oldBodyBlocked=false;
    const holdSummary=sessionStorage.getItem('fixture-warm-index')==='1';sessionStorage.removeItem('fixture-warm-index');
    const summaryGate=new Promise(resolve=>{window.releaseCachedSummary=resolve;});window.cachedSummaryReads=0;
    const toBase64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    crypto.subtle.decrypt=async(algorithm,...args)=>{
      if(holdSummary&&algorithm.iv&&toBase64(algorithm.iv)===summaryIV){window.cachedSummaryReads++;await summaryGate;}
      if(algorithm.iv&&toBase64(algorithm.iv)===iv){window.oldBodyBlocked=true;await gate;}
      return native(algorithm,...args);
    };
  },{iv:bodyIV,summaryIV});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return page;
}
try {
  const context=await browser.newContext(photoSelection?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:process.argv.includes('--mobile')?devices['Pixel 7']:{}),page=await pageFor(context);let downloads=0;page.on('download',()=>downloads++);
  await page.goto(origin+'/diary/');await page.locator('#passkey-login').click();await page.locator('#app-view').waitFor({state:'visible'});
  await page.waitForFunction(()=>window.lastPRF.every(value=>value===0));assert.equal(authentications,1);
  if(progressive) {
    await snapshotRequested;
    assert.equal(await page.locator('#app-view').isVisible(), true, 'the authorized app opens while snapshot HTTP is pending');
    assert.equal(await page.locator('#entry-list').textContent(), '読み込んでいます...');
    const stopped = page.waitForEvent('requestfailed', request => request.url().includes('/diary/api/encryption/snapshot?'));
    await page.evaluate(() => window.expireDiaryRead());
    await stopped;
    const retry = page.locator('#retry-initial-load');
    await retry.waitFor({state: 'visible'});
    assert.equal(await page.locator('#entry-list').textContent(), '日記の読み込みが時間内に完了しませんでした。');
    await retry.click();
    await page.locator('#entry-list .diary-entry-card').first().waitFor({state: 'visible'});
    assert.equal(authentications, 1, 'retry uses the current authenticated session');
    assert.equal(await retry.isVisible(), false);
    releaseSnapshot();
    await page.waitForFunction(()=>document.querySelector('#entry-list .diary-entry-card')||document.querySelector('#diary-search-status')?.textContent.includes('日記を準備できませんでした'));
    assert.ok(await page.locator('#entry-list .diary-entry-card').count(),`initial encrypted list failed: ${await page.locator('#entry-list').textContent()}`);
    await page.waitForFunction(()=>window.oldBodyBlocked);assert.ok(await page.locator('#diary-preparation-status').isVisible());
    await page.locator('#diary-search-input').fill('OLDEST_BROWSER_CANARY');
    await page.waitForFunction(()=>document.querySelector('#entry-list').textContent==='読み込んでいます...');
    await page.evaluate(()=>window.releaseOldBody());await page.waitForFunction(()=>document.querySelector('#entry-list').textContent.includes('OLDEST_BROWSER_CANARY'));
    await page.locator('#diary-search-input').fill('');await page.waitForFunction(()=>document.querySelector('#entry-list').textContent.includes('Synthetic seed'));
  }
  assert.equal(await page.getByLabel('日記の信頼設定ファイル').count(),0);assert.equal(downloads,0);
  const vault=JSON.parse(f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(user.recipientId).vault_json);
  assert.ok(vault.trust);assert.deepEqual(vault.publicKey,user.vault.publicKey);assert.deepEqual(vault.privateEnvelope,user.vault.privateEnvelope);
  await page.click('#new-entry-button');await page.locator('#editor-dialog').waitFor({state:'visible'});
  await page.fill('#entry-title','SYNTHETIC_PRIVATE_POST');await page.locator('#entry-content').fill('SYNTHETIC_PRIVATE_POST_BODY');
  if(photoSelection) {
    photoDirectory=await mkdtemp(join(tmpdir(),'diary-encrypted-photos-'));
    for(let i=0;i<31;i++){const path=join(photoDirectory,`SYNTHETIC_PRIVATE_PHOTO_${i}.png`);photoPaths.push(path);await writeFile(path,originalPng);}
    await page.evaluate(()=>{
      const nativeRead=File.prototype.arrayBuffer,nativeBitmap=window.createImageBitmap.bind(window);let release;
      const gate=new Promise(resolve=>{release=resolve;});let first=true;
      window.photoSourceReads=0;window.releasePhotoConversion=release;
      File.prototype.arrayBuffer=async function(){const bytes=await nativeRead.call(this);window.photoSourceReads++;return bytes;};
      window.createImageBitmap=async(...args)=>{if(first){first=false;window.photoConversionWaiting=true;await gate;}return nativeBitmap(...args);};
    });
    const chooser=page.waitForEvent('filechooser');await page.click('#add-photo-button');await(await chooser).setFiles(photoPaths);
    await page.waitForFunction(()=>window.photoConversionWaiting);
    assert.equal(await page.evaluate(()=>window.photoSourceReads),31,'all sources captured before conversion');
    const later=new Date(Date.now()+60000);for(const path of photoPaths.slice(2))await utimes(path,later,later);
    await page.evaluate(()=>window.releasePhotoConversion());
    await page.waitForFunction(()=>!document.querySelector('#photo-input').disabled);
    assert.equal(await page.locator('#editor-photo-list .editor-photo-card').count(),31);
  }
  await page.click('#save-entry-button');await page.locator('#editor-dialog').waitFor({state:'hidden'});
  const saved=f.db.sqlite.prepare("SELECT household,author,envelope FROM diary_e2ee_records WHERE state='published'").all();
  assert.equal(saved.length,progressive?progressiveEntries+1:1);assert.equal(saved.at(-1).author,user.serviceAccountId);assert.equal(saved.at(-1).household,user.claims.households[0]);
  assert.equal(JSON.stringify(saved).includes('SYNTHETIC_PRIVATE_POST'),false);assert.equal(JSON.stringify(wire).includes('SYNTHETIC_PRIVATE_POST_BODY'),false);
  if(photoSelection) {
    const media=f.db.sqlite.prepare('SELECT status,account_id,original_key,metadata FROM diary_e2ee_media').all();
    assert.equal(media.length,31);assert.ok(media.every(row=>row.status==='attached'&&row.account_id===user.serviceAccountId));
    assert.equal(JSON.stringify(media).includes('SYNTHETIC_PRIVATE_PHOTO'),false);assert.equal(JSON.stringify(wire).includes('SYNTHETIC_PRIVATE_PHOTO'),false);
    for(const row of media)assert.ok(photoHeader(f.r2.get(row.original_key).bytes));
    const committed=f.db.sqlite.prepare("SELECT committed_ids FROM diary_e2ee_uploads WHERE status='committed'").all();
    assert.equal(committed.length,1);assert.equal(JSON.parse(committed[0].committed_ids).length,31);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM diary_photos').get().n,0);
  }
  if(workerd){
    // Closing the editor precedes the awaited post-save list refresh. Let that
    // foreground operation finish before testing an eligible warm-cache visit.
    await page.waitForFunction(()=>!document.querySelector('#save-entry-button').disabled&&document.querySelector('#entry-list').textContent.includes('SYNTHETIC_PRIVATE_POST'));
    const {sequence}=f.db.sqlite.prepare('SELECT MAX(seq) AS sequence FROM diary_e2ee_changes WHERE household=?').get(user.claims.households[0]);
    await waitForPreparedIndex(page,sequence);
    await page.evaluate(()=>sessionStorage.setItem('fixture-warm-index','1'));
  }
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,1,'same live session resumes without another WebAuthn operation');
  if(workerd){
    await page.waitForFunction(()=>document.querySelector('#entry-list .diary-entry-card')||window.cachedSummaryReads>0||document.querySelector('#diary-search-status').textContent.includes('できません'));
    assert.equal(await page.evaluate(()=>window.cachedSummaryReads),0,`the first screen cannot wait for every old cached summary; since=${JSON.stringify(wire.filter(row=>'snapshotSince' in row).slice(-6).map(row=>row.snapshotSince))}`);
    await page.locator('#entry-list .diary-entry-card').first().waitFor({state:'visible'});
    await page.evaluate(()=>{window.releaseCachedSummary();window.releaseOldBody();});
  }
  if(photoSelection) {
    await page.locator('#entry-list .diary-entry-card').filter({hasText:'SYNTHETIC_PRIVATE_POST'}).first().click();
    await page.locator('#entry-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#detail-content .entry-photo').count(),31);
    await page.click('[data-close-dialog="entry-dialog"]');
    console.log('Encrypted photo selection: ordinary mobile account, 31 native source snapshots, source timestamp changes, encrypted metadata, original bytes, single commit and reload passed.');
  }
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});
  assert.equal(await page.locator('#tag-total-count').textContent(), 'タグ数 0');
  const storage=await inspectLogoutStorage(page);assert.equal(storage.keys,0);assert.ok(storage.cipherSnapshots>0);assert.equal(storage.containsPlaintext,false);
  if(workerd)assert.ok(storage.indexes>0,'logout preserves only encrypted derived indexes, never the unlocked device keys');
  await verifyCacheBudget(page);
  await page.click('#passkey-login');await page.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,2);
  // A different signed session cannot reuse the previous session's device key.
  await context.addCookies([{name:'troom_diary_session',value:f.cookie(user.serviceAccountId).slice('troom_diary_session='.length),domain:'127.0.0.1',path:'/diary'}]);
  await page.reload();await page.locator('#passkey-login').waitFor({state:'visible'});assert.equal(await page.locator('#app-view').isVisible(),false);
  const fresh=await browser.newContext(),freshPage=await pageFor(fresh);
  await freshPage.goto(origin+'/diary/');await freshPage.click('#passkey-login');await freshPage.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,3);
  assert.equal(await freshPage.getByLabel('日記の信頼設定ファイル').count(),0);
  if(progressive) {
    await freshPage.locator('#entry-list .diary-entry-card').first().waitFor({state:'visible'});
    await freshPage.route('**/diary/api/encryption/snapshot*',route=>{user.active=false;return route.continue();});
  }else user.active=false;
  await freshPage.reload();await freshPage.locator('#passkey-login').waitFor({state:'visible'});assert.equal(await freshPage.locator('#app-view').isVisible(),false);
  assert.equal(JSON.stringify(wire).includes(Buffer.from(user.prf).toString('base64url')),false);
  assert.equal(wire.some(row=>row.path.startsWith('/security/')),false);assert.deepEqual(errors,[]);
  if(workerd){assert.ok(compressedSnapshots>1);assert.ok(wire.some(row=>row.snapshotSince===-1));assert.ok(wire.some(row=>row.snapshotSince>=0));console.log('Android-emulated public login/list, parallel ciphertext pages, reload/cache reuse, search and writes passed through real workerd HTTP compression.');}
  console.log('Unified Diary passkey: sealed trust, fresh device, unchanged vault, secure session resume, logout/relogin, session mismatch and revocation passed without JSON (synthetic WebAuthn).');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await workerd?.close();await f.close();for(const path of photoPaths)await unlink(path).catch(()=>{});if(photoDirectory)await rmdir(photoDirectory);}
