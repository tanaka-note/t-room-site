import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';

const f=await systemFixture(),user=f.users['main-user'],root=fileURLToPath(new URL('../../public/',import.meta.url));
const wire=[],errors=[];let origin,authentications=0;
const trust=await publicTrustPackage(f.configuration);
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/diary/api/')) {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      wire.push({path:url.pathname,method:req.method,body:body.toString()});
      const reply=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )}),f.env,f.ctx);
      res.writeHead(reply.status,Object.fromEntries(reply.headers));res.end(Buffer.from(await reply.arrayBuffer()));return;
    }
    if(['/security/passkey-client.js','/assets/pwa-auto-update.js'].includes(url.pathname)){res.setHeader('Content-Type','text/javascript');res.end('/* Synthetic authentication, no production calls. */');return;}
    const file=resolve(root,url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length));
    if(!url.pathname.startsWith('/diary/')||!file.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',['.js','.mjs'].includes(extname(file))?'text/javascript':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(file));
  }catch(error){errors.push(error.name);res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
const browser=await chromium.launch({headless:true});
async function pageFor(context) {
  await context.exposeBinding('fixtureAuthentication',()=>{authentications++;});
  await context.addInitScript(({prf,credentialId,trust})=>{window.TRoomPasskeys={authenticate:async()=>{await window.fixtureAuthentication();window.lastPRF=new Uint8Array(prf);return {credentialId,prfOutput:window.lastPRF,verified:{diaryTrust:trust},link:{accountId:'main-user'},handoff:{handoffToken:'main-user',diaryTrust:trust}};}};},{prf:[...user.prf],credentialId:user.credentialId,trust});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return page;
}
try {
  const context=await browser.newContext(),page=await pageFor(context);let downloads=0;page.on('download',()=>downloads++);
  await page.goto(origin+'/diary/');await page.locator('#passkey-login').click();await page.locator('#app-view').waitFor({state:'visible'});
  await page.waitForFunction(()=>window.lastPRF.every(value=>value===0));assert.equal(authentications,1);
  assert.equal(await page.getByLabel('日記の信頼設定ファイル').count(),0);assert.equal(downloads,0);
  const vault=JSON.parse(f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(user.recipientId).vault_json);
  assert.ok(vault.trust);assert.deepEqual(vault.publicKey,user.vault.publicKey);assert.deepEqual(vault.privateEnvelope,user.vault.privateEnvelope);
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,1,'same live session resumes without another WebAuthn operation');
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});
  await page.click('#passkey-login');await page.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,2);
  // A different signed session cannot reuse the previous session's device key.
  await context.addCookies([{name:'troom_diary_session',value:f.cookie('main-user').slice('troom_diary_session='.length),domain:'127.0.0.1',path:'/diary'}]);
  await page.reload();await page.locator('#passkey-login').waitFor({state:'visible'});assert.equal(await page.locator('#app-view').isVisible(),false);
  const fresh=await browser.newContext(),freshPage=await pageFor(fresh);
  await freshPage.goto(origin+'/diary/');await freshPage.click('#passkey-login');await freshPage.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,3);
  assert.equal(await freshPage.getByLabel('日記の信頼設定ファイル').count(),0);
  f.users['main-user'].active=false;
  await freshPage.reload();await freshPage.locator('#passkey-login').waitFor({state:'visible'});assert.equal(await freshPage.locator('#app-view').isVisible(),false);
  assert.equal(JSON.stringify(wire).includes(Buffer.from(user.prf).toString('base64url')),false);
  assert.equal(wire.some(row=>row.path.startsWith('/security/')),false);assert.deepEqual(errors,[]);
  console.log('Unified Diary passkey: sealed trust, fresh device, unchanged vault, secure session resume, logout/relogin, session mismatch and revocation passed without JSON (synthetic WebAuthn).');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}
