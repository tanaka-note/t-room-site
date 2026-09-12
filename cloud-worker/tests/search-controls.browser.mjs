import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const fixture=await startUIFixture();
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});try{
  const page=await browser.newPage({viewport:{width:390,height:740}});await preparePage(page,fixture.origin,0);
  const queries=[];let releaseOld;
  await page.route('**/cloud/api/**',async route=>{
   const params=new URL(route.request().url()).searchParams;assert.equal(params.has('q'),false);
   const candidates=params.get('searchCandidates')==='1';queries.push(candidates);
   if(queries.length===1)await new Promise(r=>releaseOld=r);
   const names=candidates?['old.txt','日本 日本.txt','日本 <img src=x onerror=alert(1)>.txt']:['all.txt'];
   await route.fulfill({json:{folders:[],files:names.map((value,i)=>({id:i+1,name:value,mediaKind:'document',cryptoVersion:0,folderId:9,searchPath:'root / locked',searchDepth:1,createdAt:'2026-09-12 00:00:00'})),breadcrumbs:[],searchFolders:[{id:9,name:'locked',isProtected:true,isUnlocked:false,cryptoVersion:0}]}}).catch(()=>{});
  });
  await page.locator('#search-input').fill('old');while(!releaseOld)await page.waitForTimeout(10);
  await page.locator('#search-input').fill('日本');releaseOld();
  await page.waitForFunction(()=>document.querySelectorAll('#content-grid .file-card').length===2);
  assert.equal(await page.locator('#floating-search-input').inputValue(),'日本');
  const layout=await page.evaluate(()=>{const input=document.querySelector('#search-input').getBoundingClientRect(),button=document.querySelector('[data-search-clear="search-input"]').getBoundingClientRect();return {inside:button.top>=input.top-1&&button.bottom<=input.bottom+1&&button.right<=input.right+1,width:document.documentElement.scrollWidth,viewport:innerWidth};});
  assert.equal(layout.inside,true);assert.ok(layout.width<=layout.viewport);
  assert.equal(await page.locator('#content-grid strong mark').count(),3);
  assert.equal(await page.locator('#content-grid strong img').count(),0);
  assert.ok((await page.locator('#content-grid strong').allTextContents()).includes('日本 日本.txt'));
  // The path goes through the original folder-unlock dialog, never around its PW check.
  await page.locator('.search-path-button').first().click();await page.waitForFunction(()=>document.querySelector('#unlock-dialog').open);
  await page.keyboard.press('Escape');
  await page.locator('[data-search-clear="search-input"]').click();
  await page.waitForFunction(()=>document.querySelector('#content-grid strong')?.textContent==='all.txt');
  assert.equal(await page.locator('#floating-search-input').inputValue(),'');assert.equal(await page.locator('#search-input').inputValue(),'');
  assert.ok(queries.filter(Boolean).length>=2&&queries.includes(false));
  const previous=queries.length;
  await page.locator('#search-input').dispatchEvent('compositionstart');
  await page.locator('#search-input').fill('日本');
  await page.waitForTimeout(400);assert.equal(queries.length,previous,'IME composition must not start requests');
  await page.locator('#search-input').dispatchEvent('compositionend');
  await page.waitForFunction(()=>document.querySelectorAll('#content-grid .file-card').length===2);
  const literal=await page.evaluate(()=>{
   const e=document.createElement('strong');TCloudUI.highlightText(e,'a[A] A[a] 日本日本','[a]');
   return {text:e.textContent,matches:[...e.querySelectorAll('mark')].map(x=>x.textContent)};
  });
  assert.deepEqual(literal,{text:'a[A] A[a] 日本日本',matches:['[A]','[a]']});
  console.log('PASS synchronized clear, stale query rejection, safe highlight, protected search path',name);
 }finally{await browser.close();}
}}finally{await fixture.close();}
