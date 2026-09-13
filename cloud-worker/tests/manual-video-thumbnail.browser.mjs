import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage,makeVideoFixture} from './ui-fixture.mjs';
let fail=false,delay=0;const bodies=[];
const fixture=await startUIFixture(undefined,{handleRequest:async(req,res)=>{
 if(!req.url.endsWith('/thumbnail/manual'))return false;
 const chunks=[];for await(const chunk of req)chunks.push(chunk);bodies.push([...Buffer.concat(chunks)]);
 if(delay)await new Promise(r=>setTimeout(r,delay));
 res.writeHead(fail?500:200,{'Content-Type':'application/json'});
 res.end(JSON.stringify(fail?{error:'fixture save failed'}:{ok:true,updatedAt:'2026-09-13 12:34:56.123'}));return true;
}}), videoFixture=await makeVideoFixture(fixture.origin,{durationMs:2200,darkIntroMs:600});
try {for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try {
  const page=await browser.newPage({viewport:{width:390,height:740}});
  await preparePage(page,fixture.origin,4);
  fail=false;delay=0;bodies.length=0;
  await page.route('**/cloud/api/**',async route=>{
   if(route.request().url().endsWith('/thumbnail/manual')){
    await route.continue();
   }else await route.fulfill({json:{ok:true}});
  });
  await page.evaluate(async video=>{
   __test.videoFixture(URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type})));
   __test.state.files.forEach(f=>{f.mimeType=video.type;});
   window.cacheWrites=[];window.revoked=[];
   const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{revoked.push(url);revoke(url);};
   await __test.installThumbnailBlob(__test.state.files[1],document.querySelector('.file-card[data-file-id="2"] .thumb'),__thumb.blob);
   window.oldThumbnailUrl=__test.state.thumbnailObjectUrls.get(2);
   window.TCloudDisplayCache={...TCloudDisplayCache,putThumbnail:async(...args)=>cacheWrites.push(args)};
  },videoFixture);
  const open=async(role,changes={})=>page.evaluate(async({role,changes,synthetic})=>{
   __test.state.session.role=role;const f=__test.state.files[1];Object.assign(f,{mediaKind:'video',offlineOnly:false},changes);
   await __test.openPreview(f);
   if(synthetic && document.querySelector('#preview-stage video')){
    // Windows WebKit has no native video decoder. Exercise its UI and the real
    // capture/quality/encryption code with an explicit decoded-frame fixture.
    const v=document.querySelector('#preview-stage video');let time=1.2;
    Object.defineProperties(v,{readyState:{get:()=>4},seeking:{get:()=>false},videoWidth:{get:()=>160},videoHeight:{get:()=>90},currentTime:{get:()=>time,set:value=>{time=value;queueMicrotask(()=>v.dispatchEvent(new Event('seeked')));}}});
    window.actualCapture ||= TCloudUI.captureCurrentVideoFrame;
    window.TCloudUI={...TCloudUI,captureCurrentVideoFrame:async(video,options)=>{
     const c=document.createElement('canvas');c.width=160;c.height=90;const ctx=c.getContext('2d');ctx.fillStyle='#248080';ctx.fillRect(0,0,160,90);
     ctx.fillStyle=video.currentTime<.6?'#248080':'#fff';ctx.fillRect(80,0,80,90);
     Object.assign(c,{currentTime:video.currentTime,readyState:4,seeking:false,videoWidth:160,videoHeight:90});
     return actualCapture(c,options);
    }};
   }
  },{role,changes,synthetic:name==='webkit'});
  for(const [role,changes,visible] of [['admin',{},true],['subadmin',{},false],['member',{},false],['folder-member',{},false],['admin',{offlineOnly:true},false],['admin',{mediaKind:'image'},false],['admin',{mediaKind:'audio'},false],['admin',{mediaKind:'document'},false]]){
   await open(role,changes);
   assert.equal(await page.locator('#manual-thumbnail-button').getAttribute('hidden')===null,visible);
  }
  await open('admin');await page.locator('#preview-more summary').click();
  assert.equal(await page.getByText('サムネイル位置を変更',{exact:true}).count(),1);
  assert.equal(await page.locator('#preview-more #manual-thumbnail-button').count(),1);
  await page.evaluate(()=>{window.editorVideo=document.querySelector('#preview-stage video');window.editorTime=editorVideo.currentTime;});
  await page.locator('#manual-thumbnail-button').click();
  const visibleEditor=await page.evaluate(()=>{
   const p=document.querySelector('.manual-thumbnail-panel'),r=p.getBoundingClientRect(),d=document.querySelector('#preview-dialog').getBoundingClientRect(),actions=document.querySelector('.preview-actions').getBoundingClientRect();
   const bottom=Math.min(innerHeight,d.bottom,actions.top);
   return {visible:r.top>=Math.max(0,d.top)&&r.bottom<=bottom,bg:getComputedStyle(p).backgroundColor,same:editorVideo===document.querySelector('#preview-stage video'),time:editorVideo.currentTime===editorTime,
    buttons:[...p.querySelectorAll('button')].every(b=>{const q=b.getBoundingClientRect();return !b.disabled&&q.top>=0&&q.bottom<=bottom&&document.elementFromPoint(q.x+q.width/2,q.y+q.height/2)?.closest('button')===b;})};
  });
  assert.deepEqual(visibleEditor,{visible:true,bg:'rgb(255, 255, 255)',same:true,time:true,buttons:true});
  assert.equal(await page.locator('#preview-stage video').count(),1);
  assert.equal(await page.locator('.preview-player-seek').count(),1);
  await page.waitForFunction(()=>document.querySelector('#preview-stage video').readyState>=2);
  await page.evaluate(async()=>{
   const v=document.querySelector('#preview-stage video');window.originalVideo=v;v.pause();
   await new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=1.2;});
   window.beforeTime=v.currentTime;window.beforeImage=document.querySelector('.file-card[data-file-id="2"] .thumb').innerHTML;
  });
  fail=true;delay=200;await page.locator('[data-action="save"]').click();
  assert.equal(await page.locator('[data-action="cancel"]').isDisabled(),true);
  await page.getByText('fixture save failed',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-action="cancel"]').isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.querySelector('.file-card[data-file-id="2"] .thumb').innerHTML===beforeImage),true);
  assert.equal(await page.evaluate(()=>cacheWrites.length),0);
  fail=false;delay=0;await page.locator('[data-action="save"]').click();
  await page.locator('.manual-thumbnail-panel').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>originalVideo===document.querySelector('#preview-stage video')),true);
  assert.equal(await page.evaluate(()=>originalVideo.currentTime),1.2);
  const saved=await page.evaluate(async bytes=>{
   const f=__test.state.files[1],blob=new Blob([await TRoomCrypto.decryptThumbnail(new Uint8Array(bytes),f.fileKey)],{type:'image/webp'});
   const image=await TCloudUI.decodeThumbnail(blob);const accepted=TCloudUI.videoFrameQuality(image.image).accepted;URL.revokeObjectURL(image.url);
   return {accepted,has:f.hasThumbnail,repair:f.thumbnailNeedsRepair,cache:cacheWrites.length,img:!!document.querySelector('.file-card[data-file-id="2"] .thumb img')};
  },bodies.at(-1));
  assert.deepEqual(saved,{accepted:true,has:true,repair:false,cache:1,img:true});
  assert.equal(await page.evaluate(()=>revoked.includes(oldThumbnailUrl)),true);
  assert.deepEqual(bodies.at(-1).slice(0,4),[84,82,84,72]);
  // Bad selected frame does not seek to an automatic candidate or replace old data.
  await page.locator('#preview-more summary').click();await page.locator('#manual-thumbnail-button').click();
  await page.evaluate(async()=>{const v=originalVideo;await new Promise(r=>{v.addEventListener('seeked',r,{once:true});v.currentTime=.15;});});
  const count=bodies.length;
  await page.locator('[data-action="save"]').click();
  await page.getByText('この位置はサムネイルに適していません。少し位置をずらしてもう一度お試しください。',{exact:true}).waitFor();
  assert.equal(bodies.length,count);assert.equal(await page.evaluate(()=>originalVideo.currentTime),.15);
  assert.equal(await page.locator('[data-action="cancel"]').isEnabled(),true);
  await page.locator('[data-action="cancel"]').click();
  assert.equal(await page.locator('.manual-thumbnail-panel').count(),0);
  await page.locator('#preview-more summary').click();await page.locator('#manual-thumbnail-button').click();
  // Cancellation is disabled during the request; preview cleanup still aborts
  // and prevents a stale response from updating a different preview.
  await page.evaluate(async()=>{await new Promise(r=>{originalVideo.addEventListener('seeked',r,{once:true});originalVideo.currentTime=1.3;});});
  delay=300;await page.locator('[data-action="save"]').click();await page.locator('[data-action="save"]').click({force:true});
  const deadline=Date.now()+3000;while(bodies.length===count && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(bodies.length,count+1);
  assert.equal(await page.locator('[data-action="cancel"]').isDisabled(),true);
  await page.evaluate(()=>__test.openPreview(__test.state.files[0]));
  await new Promise(r=>setTimeout(r,400));
  assert.equal(bodies.length,count+1);assert.equal(await page.locator('.manual-thumbnail-panel').count(),0);
  assert.equal(await page.evaluate(()=>cacheWrites.length),1);
  console.log('PASS',name,name==='webkit'?'(decoded-frame fixture; native decoder unavailable)':'(native video)','admin UI, same video/seekbar, exact frame, encrypted save/cache, failure/black frame preservation, cancellation');
 }finally{await browser.close();}
}}finally{await fixture.close();}
