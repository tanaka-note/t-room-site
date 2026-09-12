import assert from 'node:assert/strict';
import {engines,root,startUIFixture,makeVideoFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce');
const fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT||root);
try{
 const video=await makeVideoFixture(fixture.origin,{durationMs:6000,darkIntroMs:2100});
 const [name,engine,launch]=engines[0],browser=await engine.launch({headless:true,...launch});
 try{
  const page=await browser.newPage();await page.goto(fixture.origin+'/cloud/');await page.waitForFunction(()=>globalThis.__test);
  const result=await page.evaluate(async video=>{
   const url=URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type}));
   const blob=await __test.captureNativeVideoThumbnail(url);URL.revokeObjectURL(url);
   if(!blob)return {present:false};
   const decoded=await TCloudUI.decodeThumbnail(blob),canvas=document.createElement('canvas');canvas.width=32;canvas.height=18;
   const c=canvas.getContext('2d');c.drawImage(decoded.image,0,0,32,18);const pixels=c.getImageData(0,0,32,18).data;
   let maximum=0;for(let i=0;i<pixels.length;i+=4)maximum=Math.max(maximum,pixels[i],pixels[i+1],pixels[i+2]);URL.revokeObjectURL(decoded.url);
   return {present:true,maximum};
  },video);
  assert.equal(result.present,true);assert.equal(result.maximum<=12,before);
  console.log(before?'REPRODUCED first-second black thumbnail':'PASS later visible video frame chosen',name,result);
  if(!before){
   await preparePage(page,fixture.origin,1);const uploads=[];
   await page.route('**/cloud/api/**',async route=>{
    assert.equal(route.request().method(),'PUT');assert.ok(route.request().url().endsWith('/thumbnail'));
    uploads.push([...route.request().postDataBuffer()]);await route.fulfill({json:{ok:true}});
   });
   await page.evaluate(async video=>{
    const url=URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type}));
    globalThis.TCloudMedia={...TCloudMedia,registerMedia:async()=>({url,token:'fixture'})};
    const file=__test.state.files[0];file.mediaKind='video';file.mimeType=video.type;file.durationSeconds=6;file.thumbnailNeedsRepair=true;
    await __test.backfillVideoThumbnail(file,__test.state.itemLoadGeneration);URL.revokeObjectURL(url);
   },video);
   assert.equal(uploads.length,1);
   const repaired=await page.evaluate(async bytes=>{
    const file=__test.state.files[0],decrypted=await TRoomCrypto.decryptThumbnail(new Uint8Array(bytes).buffer,file.fileKey);
    const decoded=await TCloudUI.decodeThumbnail(new Blob([decrypted],{type:'image/webp'}));
    const dark=TCloudUI.isBlankVideoFrame(decoded.image);URL.revokeObjectURL(decoded.url);
    const cached=await TCloudDisplayCache.getThumbnail(__test.displayCacheScope(),file.id,file.createdAt);
    return {dark,encryptedLength:bytes.length,plainLength:decrypted.byteLength,cached:!!cached,quality:document.querySelector('.thumb').dataset.thumbnailQuality};
   },uploads[0]);
   assert.equal(repaired.dark,false);assert.notEqual(repaired.encryptedLength,repaired.plainLength);assert.equal(repaired.cached,true);assert.equal(repaired.quality,'ready');
   console.log('PASS repair uploads only encrypted thumbnail, updates scoped local cache',repaired);
  }
 }finally{await browser.close();}
}finally{await fixture.close();}
