import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../../diary-worker/package.json',import.meta.url))('playwright');
const browser=await chromium.launch({headless:true});const page=await browser.newPage();page.setDefaultTimeout(5000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));let confirm=true;page.on('dialog',d=>confirm?d.accept():d.dismiss());
let sequence=0,deleteCalls=0,failVerification=false,holdDelete=false,releaseDelete;
const jobs=new Map();
const ready=id=>({id,status:'ready',sourceHostname:'example.com',createdAt:'2026-09-07T00:00:00Z',filename:'fixture.mp4',actualSize:10,expiresAt:'2099-01-01T00:00:00Z'});
jobs.set('history',ready('history'));
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());const json=body=>route.fulfill({json:body});const files={'/downloader/':'index.html','/downloader/downloader.js':'downloader.js','/downloader/delete-controls.js':'delete-controls.js','/downloader/downloader.css':'downloader.css'};
 if(files[url.pathname]){const file=files[url.pathname];return route.fulfill({body:await readFile(new URL('../public/'+file,import.meta.url)),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'});}
 if(url.pathname==='/downloader/api/session')return json({isParent:false});
 if(url.pathname==='/downloader/api/jobs')return json({jobs:[...jobs.values()]});
 if(url.pathname==='/downloader/api/analyze'){const id='job'+(++sequence);const job={...ready(id),status:'analyzed',analysis:{title:'Fixture',extractor:'direct',media:[{mediaId:'media',mediaType:'video',downloadable:true}]}};jobs.set(id,job);return json({job});}
 const match=url.pathname.match(/^\/downloader\/api\/jobs\/([^/]+)(?:\/(delete|download))?$/);
 if(match){const [,id,action]=match;let job=jobs.get(id);if(action==='download'){job=ready(id);jobs.set(id,job);}if(action==='delete'){deleteCalls++;assert.equal(route.request().method(),'POST');if(holdDelete){holdDelete=false;await new Promise(r=>releaseDelete=r);}if(!failVerification)jobs.set(id,{...job,status:'deleted'});return json({ok:true});}return json({job:jobs.get(id)});}
 return route.fulfill({body:'',contentType:'text/javascript'});
});
const getReady=async()=>{await page.locator('#source-url').fill('https://example.com/fixture.mp4');await page.locator('#analyze-button').click();await page.locator('#analysis-view').waitFor({state:'visible'});await page.locator('#rights-confirmed').check();await page.locator('#download-button').click();await page.locator('#ready-view').waitFor({state:'visible'});};
try{
 await page.goto('http://127.0.0.1:43139/downloader/');await page.locator('.job-delete').waitFor();confirm=false;await page.locator('.job-delete').click();assert.equal(deleteCalls,0);confirm=true;await page.locator('.job-delete').click();await page.waitForFunction(()=>document.querySelector('#job-list').textContent.includes('削除済み'));assert.equal(await page.locator('.job-download').count(),0);
 console.log('PASS history deletion and dismiss confirmation');
 await getReady();assert.match(await page.locator("#expiry-note").textContent(), /一時保管期限/);assert.match(await page.locator("#ready-view").textContent(), /READYになってから1時間後/);assert.doesNotMatch(await page.locator("#ready-view").textContent(), /最大12時間|最大1時間で自動削除/);failVerification=true;await page.locator('#file-delete').click();await page.waitForFunction(()=>!document.querySelector('#message').hidden&&document.querySelector('#message').textContent.includes('削除状態'));assert.equal(await page.locator('#file-download').isVisible(),true,'HTTP ok alone must not hide file');assert.equal(deleteCalls,4);failVerification=false;
 await page.locator('#file-delete').click();await page.locator('#file-delete').waitFor({state:'hidden'});assert.equal(await page.locator('#file-download').isVisible(),false);console.log('PASS ready deletion verifies D1 before hiding links');
 await getReady();assert.equal(await page.locator('#file-download').isVisible(),true,'next ready file must be visible after deletion');assert.equal(await page.locator('#file-delete').isVisible(),true);
 console.log('PASS controls restored for next download');
 holdDelete=true;await page.locator('#file-delete').click();await getReady();while(!releaseDelete)await new Promise(setImmediate);releaseDelete();await page.waitForResponse(r=>r.url().endsWith('/jobs/job2'));
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.locator('#file-download').isVisible(),true,'late delete must not hide another job');assert.equal(await page.locator('#file-delete').isVisible(),true);assert.equal(await page.locator('#file-download').getAttribute('data-job-id'),'job3');assert.deepEqual(errors,[]);console.log('PASS delayed prior deletion cannot change new ready job; no browser errors');
}finally{await browser.close()}
