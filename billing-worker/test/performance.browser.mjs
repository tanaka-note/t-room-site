import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture, seedLedger, baseline, sourceAtBaseline } from './performance-fixture.mjs';
const require = createRequire(new URL('../../diary-worker/package.json', import.meta.url));
const { chromium } = require('playwright');
const f = fixture();
seedLedger(f);
let cookie = (await f.login()).cookie;
let failSummary = false;
const held = new Map(), requests = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/billing/api/')) {
      const path = url.pathname.slice('/billing/api/'.length);
      requests.push(path.split('?')[0]);
      let result;
      if (path === 'passkey/handoff') { result = await f.login(); cookie = result.cookie; }
      else if (path === 'logout') { result = await f.request(path,cookie,{method:'POST',body:{}}); cookie = null; }
      else result = await f.request(path+url.search,cookie,{active:req.headers['x-troom-activity']==='foreground'});
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
    assert.deepEqual(requests,baseline?['session','accounts','summary']:['session','accounts']);
    const switches=[];
    for (const account of Array(3).fill(['hideaki','masami','yuuka','machiko','chiharu']).flat()) {
      switches.push(await measure(page,account,names[account]));
      assert.equal(await page.locator('#document-filter').inputValue(),account==='masami'?'payment_notice':'invoice');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if (!baseline) {
      const slow=hold('hideaki');
      await page.selectOption('#account-select','hideaki'); await waitArrived(slow);
      assert.equal(await page.locator('#summary-status').textContent(),'読み込み中…');
      assert.equal(await page.locator('#report-account').textContent(),'');
      assert.equal(await page.locator('#closing-balance').textContent(),'—');
      assert.equal(await page.locator('#print-button').isDisabled(),true);
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
      // New selection recovers without showing the failed account's data.
      await measure(page,'machiko',names.machiko);
      f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
      await page.selectOption('#account-select','hideaki');
      await page.waitForFunction(()=>!document.getElementById('login-view').hidden);
      assert.equal(await visible(page,'app-view'),false);
      assert.equal(await page.locator('#report-account').textContent(),'');
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
      assert.deepEqual(requests,baseline?['passkey/handoff','accounts','summary']:['passkey/handoff','accounts']);
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
