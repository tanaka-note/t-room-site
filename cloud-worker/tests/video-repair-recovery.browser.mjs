import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce'), fixture=await startUIFixture();
try { for(const [name,engine,launch] of engines) {
 const browser=await engine.launch({headless:true,...launch});
 try { const page=await browser.newPage(); await preparePage(page,fixture.origin,1);
 const result=await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
  const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,64,36);
  const white=TCloudUI.videoFrameQuality(canvas);
  __test.state.thumbnailAttempts.add(1);__test.resetBackgroundMediaWork();
  const attemptSurvives=__test.state.thumbnailAttempts.has(1);
  __test.state.session.role='member';__test.state.thumbnailAttempts.clear();
  const file=__test.state.files[0];file.mediaKind='video';file.hasThumbnail=false;
  __test.queueVideoThumbnailRepair(file);
  return {whiteAccepted:white.accepted,attemptSurvives,memberRepair:!!file.thumbnailNeedsRepair};
 });
 assert.deepEqual(result,before?{whiteAccepted:true,attemptSurvives:true,memberRepair:false}:{whiteAccepted:false,attemptSurvives:false,memberRepair:true});
 console.log(before?'REPRODUCED':'PASS',name,result);
 if (!before) {
  for (const role of ['member','subadmin']) {
   await preparePage(page,fixture.origin,1);
   let network=0;await page.route('**/cloud/api/**',route=>{network++;return route.fulfill({status:403,body:''});});
   const repaired=await page.evaluate(async role=>{
    Object.assign(__test.state.session,{role,serviceLinkId:"member-fixture",rootFolderId:7,serviceAccountId:"folder-member"});const file=__test.state.files[0];file.mediaKind='video';file.hasThumbnail=false;
    let registrations=0,releases=0;globalThis.TCloudMedia={...TCloudMedia,registerMedia:async()=>{registrations++;return {token:'local',url:'/local-decoder'};},releaseMedia:()=>releases++};
    globalThis.TCloudUI={...TCloudUI,recoverVideoThumbnail:async()=>__thumb.blob};
    await __test.backfillVideoThumbnail(file,__test.state.itemLoadGeneration);
    const firstImage=!!document.querySelector('.thumb img');
    const scope=__test.displayCacheScope();
    __test.resetEncryptedThumbnailLoading();document.querySelector('#content-grid').replaceChildren(__test.fileCard(file));
    await __test.backfillVideoThumbnail(file,__test.state.itemLoadGeneration);
    const cachedImage=!!document.querySelector('.thumb img');
    const stored=!!await TCloudDisplayCache.getThumbnail(scope,file.id,file.createdAt);
    __test.releaseSessionState();
    return {firstImage,cachedImage,stored,registrations,releases,keys:__test.state.crypto.folderKeys.size,imagesAfterLogout:document.querySelectorAll('.thumb img').length};
   },role);
   assert.deepEqual(repaired,{firstImage:true,cachedImage:true,stored:true,registrations:1,releases:1,keys:0,imagesAfterLogout:0});assert.equal(network,0);
   await page.unroute('**/cloud/api/**');console.log('PASS local-only recovery/cache/logout',name,role);
  }
  await preparePage(page,fixture.origin,1);
  let puts=0;await page.route('**/cloud/api/**',route=>{puts++;return route.fulfill({status:503,body:''});});
  const failedSave=await page.evaluate(async()=>{
   const file=__test.state.files[0];file.mediaKind='video';file.hasThumbnail=false;
   globalThis.TCloudMedia={...TCloudMedia,registerMedia:async()=>({token:'local',url:'/local-decoder'}),releaseMedia:()=>{}};
   globalThis.TCloudUI={...TCloudUI,recoverVideoThumbnail:async()=>__thumb.blob};
   await __test.backfillVideoThumbnail(file,__test.state.itemLoadGeneration);
   return {image:!!document.querySelector('.thumb img'),hasThumbnail:file.hasThumbnail};
  });
  assert.deepEqual(failedSave,{image:true,hasThumbnail:false});assert.equal(puts,1);await page.unroute('**/cloud/api/**');
  console.log('PASS persistence failure retains valid local image',name);
  await preparePage(page,fixture.origin,1);
  let playbackNetwork=0;await page.route('**/cloud/api/**',route=>{playbackNetwork++;return route.fulfill({status:403});});
  const playback=await page.evaluate(async()=>{
   __test.state.session.role='member';const file=__test.state.files[0];file.mediaKind='video';file.thumbnailNeedsRepair=true;
   __test.state.previewFileId=file.id;
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
   Object.assign(canvas,{readyState:4,duration:100,videoWidth:64,videoHeight:36,currentTime:40});
   const c=canvas.getContext('2d');c.fillStyle='#248080';c.fillRect(0,0,64,36);
   let seeks=0;Object.defineProperty(canvas,'currentTime',{get:()=>40,set:()=>seeks++});
   document.querySelector('#preview-stage').append(canvas);
   __test.observePlaybackThumbnail(canvas,file);canvas.dispatchEvent(new Event('seeked'));
   await new Promise(r=>setTimeout(r,100));
   return {image:!!document.querySelector('.thumb img'),seeks};
  });
  assert.deepEqual(playback,{image:true,seeks:0});assert.equal(playbackNetwork,0);console.log('PASS playback frame reused without seeks or network',name);
  await page.unroute('**/cloud/api/**');
  const selection=await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
   Object.assign(canvas,{readyState:4,duration:8000,videoWidth:64,videoHeight:36});
   let time=0;const seeks=[];const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,64,36);
   Object.defineProperty(canvas,'currentTime',{get:()=>time,set:v=>{time=v;seeks.push(v);c.fillStyle='#248080';c.fillRect(0,0,64,36);c.fillStyle='#fff';c.fillRect(32,0,32,36);queueMicrotask(()=>canvas.dispatchEvent(new Event('seeked')));}});
   const blob=await TCloudUI.selectVideoThumbnailFrame(canvas);
   return {present:!!blob,seeks};
  });
  assert.deepEqual(selection,{present:true,seeks:[10]});console.log('PASS white intro skipped and long video probes nearby frame first',name);
  const seekFailure=await page.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;
   Object.assign(canvas,{readyState:4,duration:100,videoWidth:64,videoHeight:36});
   let time=0;const seeks=[];const c=canvas.getContext('2d');c.fillRect(0,0,64,36);
   Object.defineProperty(canvas,'currentTime',{get:()=>time,set:v=>{seeks.push(v);if(v===10)throw new Error('Temporary seek failure');time=v;c.fillStyle='#fff';c.fillRect(32,0,32,36);queueMicrotask(()=>canvas.dispatchEvent(new Event('seeked')));}});
   return {present:!!await TCloudUI.selectVideoThumbnailFrame(canvas),seeks};
  });
  assert.deepEqual(seekFailure,{present:true,seeks:[10,25]});console.log('PASS failed candidate does not abandon remaining frames',name);
  const shortVideo=await page.evaluate(async()=>{
   const create=document.createElement.bind(document);let durationEvents=0;
   document.createElement=(tag,...args)=>{
    if(tag!=='video')return create(tag,...args);
    const canvas=create('canvas');canvas.width=64;canvas.height=36;
    Object.assign(canvas,{duration:.1,readyState:1,videoWidth:64,videoHeight:36,currentTime:0});
    const c=canvas.getContext('2d');c.fillStyle='#248080';c.fillRect(0,0,64,36);
    let loaded=false;canvas.load=()=>{if(loaded)return;loaded=true;queueMicrotask(()=>canvas.dispatchEvent(new Event('loadedmetadata')));setTimeout(()=>{canvas.readyState=4;canvas.dispatchEvent(new Event('loadeddata'));},20);};
    return canvas;
   };
   try{return {present:!!await TCloudUI.recoverVideoThumbnail('/local-short',undefined,()=>durationEvents++),durationEvents};}
   finally{document.createElement=create;}
  });
  assert.deepEqual(shortVideo,{present:true,durationEvents:1});console.log('PASS short video waits for decoded data and reuses duration from same decoder',name);

 }

 } finally {await browser.close();}
}} finally {await fixture.close();}
