import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const baseline=process.argv[2],fixture=await startUIFixture();
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{
  const page=await browser.newPage();await preparePage(page,fixture.origin,0);
  if(baseline)await page.addScriptTag({content:readFileSync(baseline,'utf8')});
  const result=await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const c=canvas.getContext('2d');
   Object.assign(canvas,{duration:8000,readyState:4,videoWidth:64,videoHeight:36});
   let time=0;const seeks=[];c.fillRect(0,0,64,36);
   Object.defineProperty(canvas,'currentTime',{get:()=>time,set:v=>{time=v;seeks.push(v);c.fillStyle='#000';c.fillRect(0,0,64,36);if(v===40){c.fillStyle='#fff';c.fillRect(32,0,32,36);}queueMicrotask(()=>canvas.dispatchEvent(new Event('seeked')));}});
   const blob=await TCloudUI.selectVideoThumbnailFrame(canvas);
   const flat=['#000','#fff','#888','#248080'].map(color=>{c.fillStyle=color;c.fillRect(0,0,64,36);return TCloudUI.videoFrameQuality(canvas).accepted;});
   return {present:!!blob,seeks,flat};
  });
  if(baseline){assert.equal(result.present,false);assert.deepEqual(result.seeks,[10,2000,4000,6000,7200]);console.log('REPRODUCED useful 40-second frame skipped',name,result);continue;}
  assert.deepEqual(result,{present:true,seeks:[10,40],flat:[false,false,false,false]});
  console.log('PASS nearby 40-second frame, five-candidate fallback cap, reject flat posters',name,result);
  const serial=await page.evaluate(async()=>{
   let active=0,max=0,starts=0,durations=0;
   globalThis.TCloudUI={...TCloudUI,recoverVideoThumbnail:async(url,signal,onDuration)=>{active++;max=Math.max(max,active);starts++;onDuration?.(60);await new Promise(r=>setTimeout(r,40));active--;return __thumb.blob;}};
   const file=new File(['synthetic'], 'fixture.mp4',{type:'video/mp4'}),cancel=new AbortController();
   const first=__test.makeThumbnail(file,undefined,()=>durations++);
   const second=__test.makeThumbnail(file,cancel.signal,()=>durations++);cancel.abort();
   const third=__test.makeThumbnail(file,undefined,()=>durations++);
   const results=await Promise.all([first,second,third]);
   return {max,starts,durations,present:results.map(Boolean)};
  });
  assert.deepEqual(serial,{max:1,starts:2,durations:2,present:[true,false,true]});console.log('PASS upload decoder serialization, queued cancellation, shared duration',name);
  for(const status of [401,403,419,500]){
   let calls=0;await page.route('**/cloud/api/files/1/thumbnail',route=>{calls++;return route.fulfill({status:status===500&&calls===3?200:status,json:status===500&&calls===3?{ok:true}:{error:'fixture'}});});
   const outcome=await page.evaluate(async()=>{try{await __test.saveEncryptedUploadThumbnail(1,new Blob([new Uint8Array([1,2,3])]),new AbortController().signal);return 'saved';}catch{return 'failed';}});
   assert.equal(calls,status===500?3:1);assert.equal(outcome,status===500?'saved':'failed');await page.unroute('**/cloud/api/files/1/thumbnail');
  }
  console.log('PASS bounded upload thumbnail retry, no auth retry',name);
 }finally{await browser.close();}
}}finally{await fixture.close();}
