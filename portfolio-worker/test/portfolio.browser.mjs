import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { verifyPasskeyLogin } from './passkey-login.browser.mjs';
import { pickDate, verifyDatePickers } from './date-picker.browser.mjs';
import { verifyPrincipalEditor } from './principal.browser.mjs';
import { fixture } from './fixture.js';
const require=createRequire(import.meta.url),{chromium}=require('../../diary-worker/node_modules/playwright');
const owner=fixture(),viewer=fixture('viewer');await owner.login();await viewer.login();
const publicRoot=new URL('../public/',import.meta.url),root=new URL('../../',import.meta.url);
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
const server=createServer((req,res)=>{try{
 const url=new URL(req.url,'http://localhost');let file;
 if(url.pathname.startsWith('/asset-report/'))file=new URL(url.pathname.slice('/asset-report/'.length)||'index.html',publicRoot);
 else if(url.pathname==='/security/passkey-client.js')file=new URL('security-worker/public/passkey-client.js',root);
 else if(url.pathname==='/assets/pwa-auto-update.js')file=new URL('assets/pwa-auto-update.js',root);
 else throw new Error('missing');
 const body=readFileSync(file),type=types[file.pathname.slice(file.pathname.lastIndexOf('.'))]||'text/plain';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
 }catch{res.writeHead(404);res.end('missing');}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}/asset-report/`;
const browser=await chromium.launch({headless:true});mkdirSync(new URL('../../tmp/portfolio-screens/',import.meta.url),{recursive:true});
async function routeApi(page,f){await page.route('**/asset-report/api/**',async route=>{
 const request=route.request(),u=new URL(request.url()),path=u.pathname.slice('/asset-report'.length)+u.search;
 const body=request.method()==='GET'?undefined:request.postDataJSON();const headers={};
 for(const name of ['x-portfolio-session','x-troom-activity'])if(request.headers()[name])headers[name==='x-portfolio-session'?'X-Portfolio-Session':'X-Troom-Activity']=request.headers()[name];
 const response=await f.request(path,body,headers,request.method());await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
});}
try{
 await verifyPasskeyLogin(browser, url, await owner.state());
 await verifyDatePickers(browser, url, routeApi);
 await verifyPrincipalEditor(browser, url, routeApi);
 for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());await routeApi(page,owner);await page.goto(url);await page.locator('#report-app').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#history-period').textContent.includes('2026') || document.querySelector('#app-message').textContent);
  assert.equal(await page.locator('#app-message').textContent(),'','Initial render failed');
  assert.match(await page.locator('#report-updated').textContent(),/2026年10月31日/);assert.equal(await page.locator('#holdings-body tr').count(),6);assert.deepEqual(await page.locator('.holdings-panel th').allTextContents(),['銘柄名','時価総額']);
  assert.match(await page.locator('#market-value').textContent(),/1,168,000/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#edit-toggle').click();await page.locator('#asset-editors [data-field=amount]').first().fill('500000');assert.match(await page.locator('#editor-total').textContent(),/1,400,000/);
  if(width===1440){
   const before=await page.locator('#history-chart').evaluate(canvas=>canvas.toDataURL());
   await pickDate(page, 'record-date', '2026-10-29');await page.waitForFunction(()=>document.querySelector('#editor-note').textContent.includes('新しい日付'));
   await page.locator('#record-time').fill('14:35');await page.locator('#save-button').click();await page.waitForFunction(()=>document.querySelector('#app-message').textContent.includes('チャートを更新'));
   assert.equal((await owner.state()).history.length,3);assert.notEqual(await page.locator('#history-chart').evaluate(canvas=>canvas.toDataURL()),before);
   assert.equal(await page.locator('#view-date').inputValue(),'2026-10-29');assert.match(await page.locator('#report-updated').textContent(),/14:35/);
   await pickDate(page, 'view-date', '2026-10-30');await page.waitForFunction(()=>document.querySelector('.holdings-panel').hidden);await page.locator('#edit-toggle').click();assert.equal(await page.locator('#legacy-total-label').isVisible(),true);
   await page.locator('#legacy-total').fill('1234567');await page.locator('#save-button').click();await page.waitForFunction(()=>document.querySelector('#app-message').textContent.includes('保存しました'));
   assert.equal((await owner.state()).history.find(r=>r.period==='2026-10-30').rawMarketValue,1234567);
   await pickDate(page, 'view-date', '2026-10-31');await page.locator('.holdings-panel').waitFor({state:'visible'});
  }
  if(await page.locator('#cancel-edit').isVisible())await page.locator('#cancel-edit').click();await page.screenshot({path:new URL(`../../tmp/portfolio-screens/${width}.png`,import.meta.url).pathname,fullPage:true});
  assert.deepEqual(errors,[]);await context.close();
 }
 const context=await browser.newContext(),page=await context.newPage();await routeApi(page,viewer);await page.goto(url);await page.locator('#report-app').waitFor({state:'visible'});assert.equal(await page.locator('#edit-toggle').isVisible(),false);
 viewer.setActive(false);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.locator('#login-panel').waitFor({state:'visible'});assert.equal(await page.locator('#holdings-body tr').count(),0);assert.equal(await page.locator('#market-value').textContent(),'');await context.close();
 const login=await browser.newContext(),lp=await login.newPage();await lp.route('**/asset-report/api/session',r=>r.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'パスキーでログインしてください。'})}));await lp.goto(url);await lp.locator('#login-panel').waitFor({state:'visible'});assert.equal(await lp.locator('#report-app').isVisible(),false);await login.close();
 console.log('Portfolio Chromium: desktop/mobile, backdated save, corrected history, chart refresh, viewer and logout verified.');
}finally{await browser.close();await new Promise(done=>server.close(done));owner.close();viewer.close();}
