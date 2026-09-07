import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../diary-worker/package.json',import.meta.url));
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',()=>assert.fail('cancel must not prompt'));
const origin='http://127.0.0.1:43129';
const base={id:'job',status:'analyzing',sourceHostname:'example.com',createdAt:'2026-09-07T00:00:00Z',analysis:{}};
const analyzed={...base,status:'analyzed',analysis:{title:'Normal media',extractor:'direct',media:[{mediaId:'direct',title:'Media',mediaType:'video',downloadable:true}]}};
let job=null,mode='late',cancelCalls=0,releasePoll,releaseCancel;
const files=new Map([['/downloader/','index.html'],['/downloader/downloader.js','downloader.js'],['/downloader/downloader.css','downloader.css'],['/downloader/delete-controls.js','delete-controls.js']]);
await page.route('**/*',async route=>{
 const url=new URL(route.request().url());const json=body=>route.fulfill({json:body});
 if(files.has(url.pathname)){const file=files.get(url.pathname);return route.fulfill({body:await readFile(new URL('../public/'+file,import.meta.url)),contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript'});}
 if(url.pathname==='/downloader/api/session')return json({isParent:false});
 if(url.pathname==='/downloader/api/jobs')return json({jobs:job?[job]:[]});
 if(url.pathname==='/downloader/api/analyze'){job={...base};return json({job});}
 if(url.pathname==='/downloader/api/jobs/job/cancel'){
  cancelCalls++;assert.equal(route.request().method(),'POST');assert.equal(route.request().headers()['content-type'],'application/json');
  job={...base,status:'cancelled',cancelledAt:'2026-09-07T01:00:00Z'};
  if(mode==='stop-failed'){mode='retry';return route.fulfill({status:503,json:{error:'停止を確認できません。中止ボタンで再試行してください。'}});}
  if(mode==='late')await new Promise(r=>releaseCancel=r);
  job={...job,cancelStopCompletedAt:'2026-09-07T01:00:01Z'};return json({job});
 }
 if(url.pathname==='/downloader/api/jobs/job/download'){job={...analyzed,status:'ready',filename:'safe.mp4',mimeType:'video/mp4',actualSize:10,expiresAt:'2099-01-01T00:00:00Z'};return json({job});}
 if(url.pathname==='/downloader/api/jobs/job'){
  if(mode==='late'){await new Promise(r=>releasePoll=r);return json({job:analyzed});}
  if(mode==='normal'&&job.status==='analyzing')job=analyzed;
  return json({job});
 }
 return route.fulfill({body:'',contentType:'text/javascript'});
});
const start=async()=>{await page.locator('#source-url').fill('https://example.com/media.mp4');await page.locator('#analyze-button').click();};
try{
 await page.goto(origin+'/downloader/');await page.locator('#app-view').waitFor({state:'visible'});await start();
 await page.locator('#cancel-analysis').waitFor({state:'visible'});
 await page.locator('#cancel-analysis').click();
 await page.waitForFunction(()=>document.querySelector('#cancel-analysis').textContent==='中止中…');
 assert.equal(await page.locator('#cancel-analysis').isDisabled(),true);
 while(!releaseCancel)await new Promise(setImmediate);releaseCancel();
 await page.waitForFunction(()=>document.querySelector('#message').textContent==='解析を中止しました。');
 assert.equal(await page.locator('#progress-view').isVisible(),false);assert.equal(await page.locator('#analyze-button').isEnabled(),true);
 while(!releasePoll)await new Promise(setImmediate);const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/downloader/api/jobs/job');releasePoll();await response;
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 assert.equal(await page.locator('#analysis-view').isVisible(),false,'late analyzed response cannot restore cancelled view');
 assert.match(await page.locator('#job-list').textContent(),/中止済み/);
 console.log('PASS progress cancel, busy state, late response fence, URL input restored');
 mode='stop-failed';job={...base};await page.reload();
 await page.locator('#job-list button[data-cancel-job]').click();
 await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('停止を確認できません'));
 await page.waitForFunction(()=>document.querySelector('#job-list button')?.disabled===false);
 assert.match(await page.locator('#job-list').textContent(),/中止済み/);
 await page.locator('#job-list button').click();
 await page.waitForFunction(()=>document.querySelector('#message').textContent==='解析を中止しました。');
 await page.waitForFunction(()=>!document.querySelector('#job-list button'));
 assert.equal(cancelCalls,3);console.log('PASS history after reload, stop failure and retry');
 mode='normal';await start();await page.locator('#analysis-view').waitFor({state:'visible'});assert.equal(await page.locator('#cancel-analysis').isVisible(),false);
 await page.locator('#rights-confirmed').check();await page.locator('#download-button').click();await page.locator('#ready-view').waitFor({state:'visible'});
 assert.match(await page.locator('#file-download').getAttribute('href'),/\/file\?attempt=/);
 assert.equal(await page.locator('#cancel-analysis').isVisible(),false);assert.deepEqual(errors,[]);console.log('PASS normal analysis/download UI and no browser errors (Chromium)');
}finally{await browser.close()}
