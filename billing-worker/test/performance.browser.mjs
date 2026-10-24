import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture, seedLedger, baseline, sourceAtBaseline } from './performance-fixture.mjs';
const require = createRequire(new URL('../../diary-worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const combinedInitialData = !baseline || sourceAtBaseline('billing-worker/public/billing.js').includes('includeSummary=1');
const f = fixture();
seedLedger(f);
let cookie = (await f.login()).cookie;
let failSummary = false;
let expireMutation = null;
const held = new Map(), requests = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/billing/api/')) {
      const path = url.pathname.slice('/billing/api/'.length);
      requests.push(path.split('?')[0]);
      let result;
      const financialMutation=/^(entries|settlements)(\/|$)/.test(path)&&req.method!=='GET';
      let body;
      if(req.method!=='GET') {const chunks=[];for await (const chunk of req)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
      if(financialMutation&&expireMutation==='before')f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
      if(financialMutation&&expireMutation==='after')f.beforeTouch=()=>f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
      if (path === 'passkey/handoff') { result = await f.login(); cookie = result.cookie; }
      else if (path === 'logout') { result = await f.request(path,cookie,{method:'POST',body:{}}); cookie = null; }
      else result = await f.request(path+url.search,cookie,{method:req.method,body,active:req.headers['x-troom-activity']==='foreground'});
      if(financialMutation) {f.beforeTouch=null;expireMutation=null;
        if(held.has('write')) {const gate=held.get('write');gate.arrived=true;await gate.promise;}}
      const account = url.searchParams.get('accountId');
      if (path.startsWith('summary') && held.has(account)) {
        const gate = held.get(account); gate.arrived = true;
        await gate.promise;
      }
      if (path.startsWith('summary') && failSummary) { failSummary = false; result = {status:503,body:{error:'Fixture unavailable'}}; }
      res.writeHead(result.status, { 'content-type':'application/json', 'cache-control':'no-store' });
      return res.end(JSON.stringify(result.body));
    }
    const sources = {
      '/billing/':'billing-worker/public/index.html', '/billing/billing.js':'billing-worker/public/billing.js',
      '/billing/billing.css':'billing-worker/public/billing.css', '/billing/troom-date-picker.js':'billing-worker/public/troom-date-picker.js',
      '/billing/troom-date-picker.css':'billing-worker/public/troom-date-picker.css', '/diary/dialog-navigation.js':'diary-worker/public/dialog-navigation.js',
      '/security/passkey-client.js':'security-worker/public/passkey-client.js', '/assets/pwa-auto-update.js':'assets/pwa-auto-update.js'
    };
    const file = sources[url.pathname];
    if (!file) return res.writeHead(404).end();
    const source = baseline && file.startsWith('billing-worker/') ? sourceAtBaseline(file) : await readFile(new URL(`../../${file}`,import.meta.url),'utf8');
    res.writeHead(200, { 'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html', 'cache-control':'no-store' });
    res.end(source);
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.TROOM_CHROMIUM_EXECUTABLE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ headless:true, ...(executablePath?{executablePath}:{}) });
function hold(account) {
  const gate = { arrived:false };
  gate.promise = new Promise(resolve=>{gate.release=resolve;}); held.set(account,gate); return gate;
}
async function waitArrived(gate) {
  const deadline = performance.now()+5000;
  while (!gate.arrived && performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(gate.arrived,true);
}
async function visible(page, id) { return page.locator(`#${id}`).isVisible(); }
async function assertCleared(page,{loggedOut=false}={}) {
  assert.equal(await page.locator('#settlements-card').getAttribute('aria-label'),'当月入出金。履歴を見る');
  for(const id of ['report-month','report-account','entries-body','settlements-body','settlements-dialog-context'])assert.equal(await page.locator(`#${id}`).textContent(),'');
  for(const id of ['document-total','opening-balance','closing-balance','incoming-total','outgoing-total']) {
    assert.equal(await page.locator(`#${id}`).textContent(),'—');
    assert.equal(await page.locator(`#${id}`).evaluate(node=>node.classList.contains('negative')),false);
  }
  for(const id of ['entry-id','entry-date','entry-amount','entry-description','entry-note'])assert.equal(await page.locator(`#${id}`).inputValue(),'');
  assert.equal(await page.locator('#print-button').isDisabled(),true);
  if(loggedOut) {
    assert.equal(await page.locator('dialog[open]').count(),0);
    for(const id of ['date-wheel-value','date-wheel-year','date-wheel-month','date-wheel-day'])assert.equal(await page.locator(`#${id}`).textContent(),'');
    for(const id of ['account-label','account-select','entry-account','logs-account-filter','logs-body'])assert.equal(await page.locator(`#${id}`).textContent(),'');
  }
}
async function measure(page, action, target) {
  return page.evaluate(({action,target})=>new Promise((resolve,reject)=>{
    const start = performance.now();
    const timeout = setTimeout(()=>reject(new Error(`fixture measure timed out: ${action}`)),5000);
    const observer = new MutationObserver(()=>{
      const app = document.getElementById('app-view');
      if (app.hidden || !document.getElementById('report-account').textContent.includes(target)) return;
      observer.disconnect(); clearTimeout(timeout); requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));
    });
    observer.observe(document.body,{subtree:true,childList:true,attributes:true});
    if (action==='login') document.getElementById('passkey-login').click();
    else { const select=document.getElementById('account-select');select.value=action;select.dispatchEvent(new Event('change')); }
  }),{action,target});
}
const names = Object.fromEntries(f.db.prepare('SELECT id,display_name FROM billing_accounts').all().map(a=>[a.id,a.display_name]));
try {
  for (const mobile of [false,true]) {
    const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile,isMobile:mobile});
    // Simulate a transport that ignores cancellation, to test the generation
    // check independently of AbortController. No real credentials or data.
    await context.addInitScript(()=>{
      const original = window.fetch.bind(window);
      window.fetch=(input,init={})=>original(input,String(input).includes('/api/summary')?{...init,signal:undefined}:init);
    });
    const page=await context.newPage(), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    cookie=(await f.login()).cookie;
    requests.length=0;
    await page.goto(`${origin}/billing/`);
    await page.waitForFunction(()=>!document.getElementById('app-view').hidden);
    assert.deepEqual(requests,combinedInitialData?['session','accounts']:['session','accounts','summary']);
    const switches=[];
    for (const account of Array(3).fill(['hideaki','masami','yuuka','machiko','chiharu']).flat()) {
      switches.push(await measure(page,account,names[account]));
      assert.equal(await page.locator('#document-filter').inputValue(),account==='masami'?'payment_notice':'invoice');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if (!baseline && !process.argv.includes('--measure-only')) {
      const slow=hold('hideaki');
      await page.selectOption('#account-select','hideaki'); await waitArrived(slow);
      assert.equal(await page.locator('#summary-status').textContent(),'読み込み中…');
      assert.equal(await page.locator('#report-account').textContent(),'');
      assert.equal(await page.locator('#closing-balance').textContent(),'—');
      assert.equal(await page.locator('#print-button').isDisabled(),true);
      await assertCleared(page);
      await page.selectOption('#account-select','masami');
      await page.waitForFunction(name=>document.getElementById('report-account').textContent.includes(name),names.masami);
      const oldResponse=page.waitForResponse(r=>r.url().includes('/summary?accountId=hideaki'));
      slow.release(); held.delete('hideaki'); await oldResponse;
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.ok((await page.locator('#report-account').textContent()).includes(names.masami));
      assert.equal(await page.locator('#document-title').textContent(),'支払通知書');
      const monthGate=hold('masami');
      await page.evaluate(()=>{const input=document.getElementById('month-input');input.value='2026-09';input.dispatchEvent(new Event('change'));});
      await waitArrived(monthGate);
      await assertCleared(page);
      await page.selectOption('#document-filter','invoice');
      assert.equal(await page.locator('#document-title').textContent(),'請求書');
      assert.equal(await page.locator('#document-total-label').textContent(),'請求合計');
      held.delete('masami');
      await page.evaluate(()=>{const input=document.getElementById('month-input');input.value='2026-08';input.dispatchEvent(new Event('change'));});
      await page.selectOption('#document-filter','invoice');
      await page.waitForFunction(()=>document.getElementById('report-month').textContent==='2026年8月');
      const monthResponse=page.waitForResponse(r=>r.url().includes('month=2026-09'));
      monthGate.release();held.delete('masami');await monthResponse;
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#report-month').textContent(),'2026年8月');
      assert.equal(await page.locator('#document-title').textContent(),'請求書');
      failSummary=true;
      await page.selectOption('#account-select','yuuka');
      await page.waitForFunction(()=>document.getElementById('summary-status').textContent==='Fixture unavailable');
      assert.equal(await page.locator('#report-account').textContent(),'');
      assert.equal(await page.locator('#new-entry-button').isDisabled(),true);
      await assertCleared(page);
      // New selection recovers without showing the failed account's data.
      await measure(page,'machiko',names.machiko);
      assert.match(await page.locator('#settlements-card').getAttribute('aria-label'),/当月入出金。入金/);
      // A held B response fails after A was fully rendered, including ARIA.
      const failed=hold('yuuka');failSummary=true;
      await page.selectOption('#account-select','yuuka');await waitArrived(failed);await assertCleared(page);
      const failedResponse=page.waitForResponse(r=>r.url().includes('/summary?accountId=yuuka'));
      failed.release();held.delete('yuuka');await failedResponse;
      await page.waitForFunction(()=>document.getElementById('summary-status').textContent==='Fixture unavailable');await assertCleared(page);
      await page.reload();await page.waitForFunction(()=>!document.getElementById('app-view').hidden);
      await measure(page,'masami',names.masami);
      await page.emulateMedia({media:'print'});
      assert.equal(await page.locator('#document-title').textContent(),'支払通知書');
      assert.ok((await page.locator('#report-account').textContent()).includes(names.masami));
      assert.equal((await page.pdf({format:'A4'})).subarray(0,4).toString(),'%PDF');
      await page.emulateMedia({media:'screen'});
      await page.evaluate(()=>{window.fixturePrints=0;window.print=()=>window.fixturePrints++;});
      await page.click('#print-button');assert.equal(await page.evaluate(()=>window.fixturePrints),1);
      // Actual committed save followed by touch revocation; hold its 401 to
      // check duplicate-submit protection and the absence of auto retries.
      const write=hold('write');expireMutation='after';
      const countBefore=f.db.prepare('SELECT COUNT(*) AS n FROM billing_entries').get().n;
      await page.click('#new-entry-button');
      const savedDescription=`Fixture saved once ${mobile?'touch':'mouse'}`;
      await page.fill('#entry-amount','3197');await page.fill('#entry-description',savedDescription);
      await page.evaluate(()=>{document.getElementById('entry-date').value='2026-10-24';});
      requests.length=0;await page.click('#entry-form button[type=submit]');await waitArrived(write);
      await page.locator('#entry-form').dispatchEvent('submit');
      assert.equal(requests.filter(p=>p==='entries').length,1);
      const writeResponse=page.waitForResponse(r=>r.url().endsWith('/api/entries'));
      write.release();held.delete('write');const rejected=await writeResponse;
      assert.equal(rejected.status(),401);assert.deepEqual(Object.keys(await rejected.json()),['error']);
      await page.waitForFunction(()=>!document.getElementById('login-view').hidden);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM billing_entries').get().n,countBefore+1);
      await assertCleared(page,{loggedOut:true});
      assert.equal(await visible(page,'login-operation-note'),true);
      assert.match(await page.locator('#login-operation-note').textContent(),/保存されている可能性.*同じ操作を繰り返さない/);
      f.securityDb.exec("UPDATE security_credentials SET status='active'");
      await page.evaluate(()=>{window.TRoomPasskeys={...window.TRoomPasskeys,authenticate:async()=>({handoff:{handoffToken:'local-fixture'}})};});
      await measure(page,'login',names.masami);
      assert.equal(await page.locator('#month-input').inputValue(),'2026-10');
      assert.equal(await page.locator('#entries-body').getByText(savedDescription,{exact:true}).count(),1);
      assert.equal(await visible(page,'login-operation-note'),false);
      assert.equal(requests.filter(p=>p==='entries').length,1);
      await page.click('#logout-button');
      await page.waitForFunction(()=>!document.getElementById('login-view').hidden);
      await assertCleared(page,{loggedOut:true});
      await measure(page,'login',names.chiharu);
      f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
      await page.selectOption('#account-select','hideaki');
      await page.waitForFunction(()=>!document.getElementById('login-view').hidden);
      assert.equal(await visible(page,'app-view'),false);
      assert.equal(await page.locator('#report-account').textContent(),'');
      await assertCleared(page,{loggedOut:true});
      f.securityDb.exec("UPDATE security_credentials SET status='active'");
    }
    // Real Worker handoff/session issuance; only OS WebAuthn is stubbed.
    const logins=[];
    for(let i=0;i<12;i++) {
      cookie=null;await page.goto(`${origin}/billing/`);
      await page.waitForFunction(()=>!document.getElementById('login-view').hidden);
      await page.evaluate(()=>{window.TRoomPasskeys={...window.TRoomPasskeys,authenticate:async()=>({handoff:{handoffToken:'local-fixture'}})};});
      requests.length=0;
      const loginMs=await measure(page,'login',names.chiharu);
      if(i>=2)logins.push(loginMs);
      assert.deepEqual(requests,combinedInitialData?['passkey/handoff','accounts']:['passkey/handoff','accounts','summary']);
    }
    const resources=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('/billing/api/')).map(e=>({endpoint:new URL(e.name).pathname.split('/').pop(),durationMs:e.duration})));
    const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
    console.log(JSON.stringify({fixture:'local browser + SQLite; WebAuthn stubbed; two animation frames',mobile,baseline:baseline||false,loginAfterStubMedianMs:median(logins),loginSamples:logins.length,accountSwitchMedianMs:median(switches),accountSwitchSamples:switches.length,resources}));
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('billing performance browser: passed');
} finally {
  for(const gate of held.values())gate.release();
  await browser.close();await new Promise(resolve=>server.close(resolve));f.close();
}
