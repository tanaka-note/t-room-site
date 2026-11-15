import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {retirementWorker, legacyReportResponse} from '../site-worker/index.mjs';
const require=createRequire(new URL('../diary-worker/package.json',import.meta.url));
const {chromium}=require('playwright');
const old='/asset-report-k7m4q9x2/';
let retired=false;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/asset-report/') {res.setHeader('Content-Type','text/html');res.end('<title>New report</title>New report');return;}
  if(retired){const response=legacyReportResponse(new Request(url,{method:req.method}));if(response){res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());return;}}
  res.setHeader('Cache-Control','no-store');
  if(url.pathname===`${old}service-worker.js`){
    res.setHeader('Content-Type','application/javascript');
    // An installed legacy worker with cached financial content and another app's cache.
    res.end(`self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open('asset-report-shell-legacy');await c.put('${old}data/portfolio-data.mjs',new Response('legacy financial fixture'));await caches.open('unrelated-app');self.skipWaiting()})()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));`);return;
  }
  res.setHeader('Content-Type','text/html');res.end('<title>Legacy fixture</title>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.goto(origin+old);
  await page.evaluate(async()=>{await navigator.serviceWorker.register('./service-worker.js?v=legacy');await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.deepEqual((await page.evaluate(()=>caches.keys())).sort(),['asset-report-shell-legacy','unrelated-app']);
  retired=true;
  // Same URL, including a historical query string, must receive cleanup JavaScript.
  await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
  await page.waitForURL(origin+'/asset-report/');
  await page.waitForFunction(async()=>!(await navigator.serviceWorker.getRegistrations()).length);
  assert.deepEqual(await page.evaluate(()=>caches.keys()),['unrelated-app']);
  const document=await page.request.get(origin+old+'?source=pwa',{maxRedirects:0});
  assert.equal(document.status(),308);assert.equal(document.headers().location,'/asset-report/');
  assert.equal((await page.request.get(origin+old+'data/portfolio-data.mjs?v=legacy')).status(),410);
  const sw=await page.request.get(origin+old+'service-worker.js?v=legacy');assert.equal(await sw.text(),retirementWorker);
  console.log('Legacy PWA update: new page, old cache removed, other app cache preserved, registration removed; redirect and data shutdown passed.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
