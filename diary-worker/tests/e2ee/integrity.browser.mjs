import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_PACKAGE||(process.env.TROOM_BROWSER==='webkit'?'playwright-webkit':'playwright'));
const engine=process.env.TROOM_BROWSER==='webkit'?webkit:chromium;
import { systemFixture } from './system-fixture.mjs';
import { publicTrustPackage } from '../../e2ee/setup.mjs';
import { EncryptedDiaryClient } from '../../e2ee/client.mjs';
import { readSnapshotPages } from '../../e2ee/snapshot.mjs';

const f = await systemFixture();
f.env.DIARY_MAIN_ADMIN_LOGIN_ID='synthetic-main@example.test';
const user = f.users[process.argv.includes('--independent-editor') ? 'chiharu-admin' : 'main-admin'];
const root = resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const trust = await publicTrustPackage(f.configuration);
const requests = [], errors = [];
let holdNextSession=false,releaseSession,sessionEntered;
let origin, failRetire = false, failAttachment = false, failFinalize = false, afterCommit = false;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname.startsWith('/diary/api/')) {
      if(holdNextSession&&url.pathname==='/diary/api/session'){holdNextSession=false;sessionEntered();await new Promise(resolve=>{releaseSession=resolve;});}
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const sample = { path: url.pathname, method: request.method, body: body.toString() };
      requests.push(sample);
      const mutation = url.pathname.endsWith('/encryption/mutation') ? JSON.parse(body) : null;
      const attaching = mutation?.proposal?.photoIds?.some(id => f.db.sqlite.prepare('SELECT status FROM diary_e2ee_media WHERE id=?').get(id)?.status === 'ready');
      if ((failRetire && /\/encryption\/media\//.test(url.pathname)) || (failAttachment && attaching) || (failFinalize && afterCommit && mutation)) {
        sample.status = 503;
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Synthetic retryable photo operation failure' }));
        return;
      }
      const result = await f.worker.fetch(new Request(url, { method: request.method, headers: request.headers, ...(body.length ? { body } : {}) }), f.env, f.ctx);
      sample.status = result.status;
      if (result.ok && /\/encryption\/uploads\/[^/]+\/commit$/.test(url.pathname)) {
        afterCommit = true;
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer())); return;
    }
    if (url.pathname === '/diary/' && url.searchParams.has('takeout-migration')) {
      const result = await f.worker.fetch(new Request(url), f.env, f.ctx);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end();
      return;
    }
    if (['/security/passkey-client.js', '/assets/pwa-auto-update.js'].includes(url.pathname)) {
      response.setHeader('Content-Type', 'text/javascript'); response.end('/* Synthetic authentication; no production calls. */'); return;
    }
    const file = resolve(root, url.pathname === '/diary/' ? 'index.html' : url.pathname.slice('/diary/'.length));
    if (!url.pathname.startsWith('/diary/') || !file.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', ['.js', '.mjs'].includes(extname(file)) ? 'text/javascript' : extname(file) === '.html' ? 'text/html' : extname(file) === '.css' ? 'text/css' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) { errors.push(error.message); response.writeHead(500); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`; f.env.DIARY_ENCRYPTION_ORIGIN = origin;
const browser = await engine.launch({headless:true,...(engine===chromium?(process.env.TROOM_CHROMIUM_CHANNEL?{channel:process.env.TROOM_CHROMIUM_CHANNEL}:process.env.TROOM_CHROMIUM_EXECUTABLE?{executablePath:process.env.TROOM_CHROMIUM_EXECUTABLE}:{}):{})});
let context;
try {
  const desktop = process.argv.includes('--desktop');
  context = await browser.newContext({ viewport: { width: desktop ? 1280 : 390, height: 844 }, isMobile: !desktop, hasTouch: !desktop });
  await context.addInitScript(({ prf, credentialId, trust, accountId }) => {
    window.TRoomPasskeys = { authenticate: async () => ({ credentialId, prfOutput: new Uint8Array(prf), verified: { diaryTrust: trust }, link: { accountId }, handoff: { handoffToken: accountId, diaryTrust: trust } }) };
    const originalInterval=window.setInterval;window.syntheticSyncTimers=[];
    window.setInterval=(fn,ms,...args)=>{if(ms===30000)window.syntheticSyncTimers.push(fn);return originalInterval(fn,ms,...args);};
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const response = await nativeFetch(input, init);
      if (window.losePhotoCommitReply && init.method === 'POST' && /\/encryption\/uploads\/[^/]+\/commit$/.test(new URL(input, location.href).pathname)) {
        window.losePhotoCommitReply = false;
        throw new TypeError('Synthetic response loss after confirmed commit');
      }
      return response;
    };
  }, { prf: [...user.prf], credentialId: user.credentialId, trust, accountId: user.serviceAccountId });
  async function signIn(page,path='/diary/'){
    page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+path);
    await page.locator('#login-view').waitFor({state:'visible'});await page.click('#passkey-login');
    await page.locator('#app-view').waitFor({state:'visible'});
  }
  const selectedHousehold=user.claims.isGlobalOwner?'chiharu-household':user.claims.households[0];
  async function selectHousehold(page,target=selectedHousehold){
    if(!user.claims.isGlobalOwner)return;
    await page.locator('#household-switcher').waitFor({state:'visible'});
    if(await page.inputValue('#household-switcher')!==target){
      await page.selectOption('#household-switcher',target);
      await page.waitForFunction(()=>!document.querySelector('#household-switcher').disabled);
    }
  }
  async function writer(){
    let cookie=f.cookie(user.serviceAccountId);
    if(selectedHousehold!==user.claims.households[0]){
      const result=await f.worker.fetch(new Request(origin+'/diary/api/households/select',{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-Diary-Request':'1','Content-Type':'application/json'},body:JSON.stringify({householdId:selectedHousehold})}),f.env,f.ctx);
      assert.equal(result.status,200);cookie=result.headers.get('Set-Cookie').split(';')[0];
    }
    const call=async(path,body)=>{
      const result=await f.worker.fetch(new Request(origin+'/diary/api/encryption'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:origin,'X-Diary-Request':'1','Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,f.ctx);
      const value=await result.json();assert.equal(result.status,200,JSON.stringify(value));return value;
    };
    const {profile}=await call('/profile');
    const instance=new EncryptedDiaryClient({profile,anchor:trust.anchor,documentFormat:2,transport:{valid:async()=>true,timestamp:async()=>(await call('/time')).timestamp,snapshot:(h,since)=>readSnapshotPages(options=>call('/snapshot?'+new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))),h,since),mutation:(proposal,operation)=>call('/mutation',{proposal,operation})}});
    await instance.unlock(new Uint8Array(user.prf));return instance;
  }
  const page=await context.newPage();await signIn(page);await selectHousehold(page);
  if(user.claims.isGlobalOwner){
    const entered=new Promise(resolve=>{sessionEntered=resolve;});holdNextSession=true;
    await page.fill('#diary-search-input','SYNTHETIC_PENDING_OLD_HOUSEHOLD');await entered;
    await selectHousehold(page,'tanaka-household');releaseSession();
    await page.waitForTimeout(100);assert.equal(await page.locator('#app-view').isVisible(),true,'a late old-household session response must not lock the new household');
    assert.equal(await page.inputValue('#diary-search-input'),'');await selectHousehold(page);
  }

  await page.click('#new-entry-button');await page.fill('#entry-title','SYNTHETIC_UNSAVED_TITLE');await page.locator('#entry-content').fill('SYNTHETIC_UNSAVED_BODY');
  const handoffsBefore=requests.filter(r=>r.path.endsWith('/passkey/handoff')).length;
  const second=await context.newPage();await second.goto(origin+'/diary/');await second.locator('#app-view').waitFor({state:'visible'});
  assert.equal(requests.filter(r=>r.path.endsWith('/passkey/handoff')).length,handoffsBefore,'the second tab resumes the same live session');
  assert.equal(await page.inputValue('#entry-title'),'SYNTHETIC_UNSAVED_TITLE');assert.equal(await page.locator('#entry-content').textContent(),'SYNTHETIC_UNSAVED_BODY');assert.equal(await page.locator('#editor-dialog').evaluate(node=>node.open),true);
  const other=await writer();
  const sharedTag = 'SYNTHETIC_PUBLISHED_TAG';
  const draftOnlyTag = 'SYNTHETIC_DRAFT_ONLY_TAG';
  const external=(await other.saveEntry({entryDate:new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),title:'SYNTHETIC_EXTERNAL_POST',content:'SYNTHETIC_EXTERNAL_BODY',tags:[sharedTag],weather:null,status:'published'})).entry;
  await page.evaluate(()=>window.syntheticSyncTimers.forEach(fn=>fn()));
  await page.locator(`#entry-list [data-entry-id="${external.id}"]`).waitFor({state:'attached'});
  assert.equal(await page.inputValue('#entry-title'),'SYNTHETIC_UNSAVED_TITLE','background list refresh must not overwrite an editor');
  assert.equal(await page.locator('#entry-content').textContent(),'SYNTHETIC_UNSAVED_BODY');
  await second.click('#logout-button');await page.locator('#login-view').waitFor({state:'visible'});
  assert.equal(await page.inputValue('#entry-title'),'');assert.equal(await page.locator('#entry-content').textContent(),'');
  assert.equal(await page.locator('#editor-dialog').evaluate(node=>node.open),false,'a real logout still clears every tab');
  await second.close();await page.click('#passkey-login');await page.locator('#app-view').waitFor({state:'visible'});await selectHousehold(page);
  await page.locator(`#entry-list [data-entry-id="${external.id}"]`).click();await page.click('#edit-entry-button');
  await page.fill('#entry-title', 'SYNTHETIC_EDIT_DRAFT');
  await page.fill('#entry-tags', [sharedTag, draftOnlyTag].join('、'));
  await page.click('#save-draft-button');
  await page.locator('#editor-dialog').waitFor({state: 'hidden'});
  const draft=f.db.sqlite.prepare("SELECT id FROM diary_e2ee_records WHERE state='draft' AND source_id=?").get(String(external.id));assert.ok(draft);

  await page.reload();
  await page.locator('#app-view').waitFor({state: 'visible'});
  await selectHousehold(page);
  const draftButton = page.locator('#draft-button');
  if (await draftButton.getAttribute('aria-pressed') !== 'true') await draftButton.click();
  const draftCard = page.locator('#entry-list .diary-entry-card').filter({hasText: 'SYNTHETIC_EDIT_DRAFT'});
  await draftCard.waitFor({state: 'visible', timeout: 10000});
  assert.equal(await draftCard.locator('span.diary-tag').textContent(), '#' + draftOnlyTag);
  assert.match(await draftCard.getByRole('link', {name: '#' + sharedTag}).getAttribute('href'), /^\/diary\/tag\/e_/);

  await other.sync();await other.saveEntry({...other.entry(external.id),title:'SYNTHETIC_OTHER_DEVICE_UPDATED'},String(external.id));
  await page.locator(`#entry-list [data-entry-id="${draft.id}"]`).click();
  await page.locator('#editor-dialog').waitFor({state: 'visible'});
  assert.equal(await page.inputValue('#entry-title'), 'SYNTHETIC_EDIT_DRAFT');
  assert.equal(await page.locator('#entry-content').textContent(), 'SYNTHETIC_EXTERNAL_BODY');
  assert.equal(await page.inputValue('#entry-tags'), [sharedTag, draftOnlyTag].join('、'));
  await page.fill('#entry-title','SYNTHETIC_CONTINUED_DRAFT');await page.click('#save-draft-button');await page.locator('#editor-dialog').waitFor({state:'hidden'});
  await page.locator(`#entry-list [data-entry-id="${draft.id}"]`).click();await page.click('#save-entry-button');
  await page.waitForFunction(()=>!document.querySelector('#save-entry-button').disabled&&document.querySelector('#editor-message').textContent);
  assert.equal(await page.inputValue('#entry-title'),'SYNTHETIC_CONTINUED_DRAFT');assert.equal(await page.locator('#editor-dialog').evaluate(node=>node.open),true);
  await page.click('[data-close-dialog="editor-dialog"]');
  // Reopening the saved draft has no changes after its rejected publication.
  if(await page.locator('#editor-leave-dialog').evaluate(node=>node.open))await page.click('#editor-leave-discard');
  await page.locator('#editor-dialog').waitFor({state:'hidden'});
  await page.click('#draft-button');await page.locator(`#entry-list [data-entry-id="${external.id}"]`).click();await page.click('#delete-entry-button');await page.click('#delete-confirm-yes');
  await page.locator('#entry-dialog').waitFor({state:'hidden'});await page.click('#trash-button');
  await page.locator(`#entry-list [data-entry-id="${external.id}"]`).waitFor({state:'attached'});
  assert.match(await page.locator(`#entry-list [data-entry-id="${external.id}"]`).textContent(),/削除者：/);
  await page.locator(`#entry-list [data-entry-id="${external.id}"]`).click();await page.locator('#entry-dialog').waitFor({state:'visible'});assert.match(await page.locator('#detail-deletion').textContent(),/削除者：/);
  await page.click('#restore-entry-button');await page.locator('#entry-dialog').waitFor({state:'hidden'});
  other.lock();
  await page.goto(origin+'/diary/?takeout-migration=2026');
  await page.waitForURL(origin+'/diary/');
  await page.locator('#app-view').waitFor({state:'visible'});
  await page.locator(`#entry-list [data-entry-id="${external.id}"]`).waitFor({state:'visible'});
  assert.equal(await page.locator('#migration-folder').count(),0);
  assert.equal(requests.filter(r=>r.status===426).length,0,'the ordinary encrypted diary avoids guarded legacy routes');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({engine:process.env.TROOM_BROWSER||'chromium',desktop:process.argv.includes('--desktop'),account:user.serviceAccountId,sameSessionTabs:true,logoutClears:true,liveRefreshPreservesEditor:true,staleDraftSave:true,publicationConflict:true,deletedByVisible:true,retiredTakeoutOpensDiary:true,noLegacyApi:true}));
} finally {
  releaseSession?.();await context?.close();await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();
}
