import assert from 'node:assert/strict';
import {engines,startUIFixture,makeVideoFixture} from './ui-fixture.mjs';
const fixture=await startUIFixture(),video=await makeVideoFixture(fixture.origin);
try {for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try {for(const mobile of [false,true]){
  const page=await browser.newPage({viewport:mobile?{width:390,height:740}:{width:1280,height:900}});
  page.on('pageerror',e=>console.log('FIXTURE ERROR',name,e.message));
  await page.goto(fixture.origin+'/cloud/share/'+'A'.repeat(43));await page.waitForFunction(()=>globalThis.__share);
  let calls=0;await page.route('**/cloud/api/**',route=>{calls++;return route.fulfill({json:{}});});
  await page.evaluate(video=>{
   __share.bindEvents();__share.videoFixture(URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type})));
   __share.prepare(Array.from({length:128},(_,i)=>({id:i+1,name:'fixture '+i,mediaKind:'video',mimeType:video.type,createdAt:'2026-09-12 00:00:00',sizeBytes:100})));
   __share.renderSortedItems();
  },video);
  const outcomes=[];
  for(const action of ['x','back','escape','backdrop']){
   await page.evaluate(()=>window.scrollTo(0,3000));
   const y=await page.evaluate(()=>window.scrollY);
   const id=await page.evaluate(()=>[...document.querySelectorAll('#items .file')].find(c=>{const r=c.getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight;})?.dataset.fileId);
   assert.ok(id);console.log('CLOSE CASE',name,mobile,action,id);await page.locator('#items .file[data-file-id="'+id+'"] > button:first-child').click();
   await page.waitForFunction(()=>document.querySelector('#preview-dialog').open);
   if(action==='x')await page.locator('#preview-dialog .close').click();
   if(action==='back')await page.goBack();
   if(action==='escape')await page.keyboard.press('Escape');
   if(action==='backdrop')await page.mouse.click(1,1);
   await page.waitForFunction(()=>!document.querySelector('#preview-dialog').open&&!history.state?.previewId);
   await page.waitForTimeout(150);
   const result=await page.evaluate(()=>({y:scrollY,token:__share.state.previewMediaToken,selected:__share.state.selected,pending:__share.state.previewClosePending}));
   assert.ok(Math.abs(y-result.y)<=2,JSON.stringify({name,mobile,action,y,result}));
   assert.equal(result.token,'');assert.equal(result.selected,null);assert.equal(result.pending,false);
   outcomes.push({action,error:result.y-y});
  }
  assert.equal(calls,0);console.log('PASS shared preview close',name,{mobile,outcomes,refetches:calls});await page.close();
 }}finally{await browser.close();}
}}finally{await fixture.close();}
