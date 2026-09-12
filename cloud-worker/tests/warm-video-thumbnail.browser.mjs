import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce'),fixture=await startUIFixture();
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});try{
  const page=await browser.newPage();await preparePage(page,fixture.origin,1);
  await page.evaluate(async()=>{
   const c=document.createElement('canvas');c.width=64;c.height=64;c.getContext('2d').fillRect(0,0,64,64);
   const blob=await new Promise(r=>c.toBlob(r,'image/png'));
   __test.state.thumbnailObjectUrls.set(1,URL.createObjectURL(blob));
   __test.state.view='history'; // Isolate the quality check from asynchronous video backfill.
   const file={...__test.state.files[0],mediaKind:'video'};__test.state.files=[file];
   document.querySelector('#content-grid').replaceChildren(__test.fileCard(file));
  });
  if(before)await page.waitForFunction(()=>document.querySelector('.thumb img')?.naturalWidth>0);
  else await page.waitForFunction(()=>document.querySelector('.thumb')?.dataset.thumbnailQuality==='dark-frame');
  const result=await page.evaluate(()=>({quality:document.querySelector('.thumb').dataset.thumbnailQuality||'unchecked',repair:!!__test.state.files[0].thumbnailNeedsRepair}));
  assert.equal(result.quality,before?'unchecked':'dark-frame');assert.equal(result.repair,!before);
  if(!before){assert.equal(await page.locator('.thumb img').count(),0);assert.equal(await page.locator('.thumb svg').count(),1);}
  console.log(before?'REPRODUCED cached object URL skips video quality check':'PASS cached object URL retains dark frame recovery',name,result);
 }finally{await browser.close();}
}}finally{await fixture.close();}
