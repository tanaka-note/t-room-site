// Synthetic local SQLite + browser measurements; no production or remote D1/R2.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fixture} from './fixture.js';
const {chromium}=createRequire(import.meta.url)('../../diary-worker/node_modules/playwright');
const browser=await chromium.launch({headless:true}),results=[];
const median=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];
try{for(const count of [100,1000,10000,20000]){
 const f=fixture();await f.login();const original=await f.state(),dataset=f.sqlite.prepare('SELECT active_dataset id FROM household_state').get().id,category=original.data.categories.find(c=>c.type==='expense').id;
 const insert=f.sqlite.prepare('INSERT INTO household_records VALUES(?,?,?,?)');f.sqlite.exec('BEGIN');
 const values=Array.from({length:count},(_,i)=>({id:crypto.randomUUID(),date:'2026-09-15',type:'expense',amount:i+1,categoryId:category,description:'Synthetic '+i,notes:'fixture only',accountId:null,included:true}));
 for(const value of values)insert.run(dataset,'transactions',value.id,JSON.stringify(value));f.sqlite.exec('COMMIT');
 const reads=[],saves=[];let writes;
 for(let i=0;i<3;i++){let t=performance.now();await f.state();reads.push(performance.now()-t);const before=f.sqlite.prepare('SELECT total_changes() n').get().n;t=performance.now();const response=await f.mutate('transaction.save',{...values[0],amount:100+i});saves.push(performance.now()-t);assert.equal(response.status,200);writes=f.sqlite.prepare('SELECT total_changes() n').get().n-before;assert.equal(writes,3,'one changed record, revision and receipt');}
 const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname.startsWith('/household/api/')){const chunks=[];for await(const c of req)chunks.push(c);const text=Buffer.concat(chunks).toString(),r=await f.request(u.pathname.slice('/household'.length),text?JSON.parse(text):undefined,{},req.method);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));return;}
 const path=u.pathname.startsWith('/household/')?new URL('../public/'+(u.pathname.slice(11)||'index.html'),import.meta.url):new URL('../..'+u.pathname,import.meta.url);res.setHeader('Content-Type',path.pathname.endsWith('.js')?'text/javascript':path.pathname.endsWith('.css')?'text/css':path.pathname.endsWith('.webmanifest')?'application/manifest+json':'text/html');res.end(readFileSync(path));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{await page.addInitScript(()=>localStorage.clear());const t=performance.now();await page.goto(`http://127.0.0.1:${server.address().port}/household/`);await page.locator('#app-view').waitFor({state:'visible'});await page.locator('#period').evaluate(el=>{el.value='2026-09';el.dispatchEvent(new Event('change'));});await page.waitForFunction(n=>document.querySelectorAll('#entries tr').length===Math.min(n,200),count);
 const startupRenderMs=performance.now()-t,renderMs=await page.evaluate(()=>{const t=performance.now();document.querySelector('#search').value='Synthetic';document.querySelector('#search').dispatchEvent(new Event('input'));return performance.now()-t;});
 const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');const heap=await cdp.send('Runtime.getHeapUsage');const nodes=await page.locator('*').count();
 const saveStart=performance.now();await page.locator('#entries tr').first().getByRole('button',{name:'編集',exact:true}).click();await page.locator('#entry-form [name=amount]').fill('999');await page.locator('#entry-form [type=submit]').click();await page.locator('#entry-dialog').waitFor({state:'hidden'});const browserSaveMs=performance.now()-saveStart;
 assert.equal((await f.state()).data.transactions.length,count);assert.deepEqual(errors,[]);
 const total=await page.locator('#expense').textContent();if(count>200){await page.locator('#more-entries').click();assert.equal(await page.locator('#entries tr').count(),400);assert.equal(await page.locator('#expense').textContent(),total);const ids=await page.locator('#entries tr').evaluateAll(rows=>rows.map(r=>r.dataset.id));assert.equal(new Set(ids).size,400);await page.locator('#search').fill('Synthetic 99');assert.ok(await page.locator('#entries tr').count()<=200);await page.locator('#search').fill('');assert.equal(await page.locator('#entries tr').count(),200);}results.push({count,apiReadMedianMs:median(reads),apiSaveWithReadMedianMs:median(saves),changedRows:writes,startupAndRenderMs:startupRenderMs,filterRenderMs:renderMs,browserSaveMs,retainedJsHeapMiB:heap.usedSize/1048576,domNodes:nodes});
 console.log(JSON.stringify(results.at(-1)));
 }finally{await context.close();await new Promise(r=>server.close(r));f.close();}
}}finally{await browser.close();}
mkdirSync('tmp/household-performance',{recursive:true});writeFileSync('tmp/household-performance/results.json',JSON.stringify({node:process.version,platform:process.platform,browser:'Chromium',note:'Local synthetic measurements; retained JS heap is not peak or total device memory.',results},null,2)+'\n');
