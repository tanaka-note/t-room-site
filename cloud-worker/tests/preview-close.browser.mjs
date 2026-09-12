import assert from 'node:assert/strict';
import {engines,root,startUIFixture,preparePage,makeVideoFixture} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce');
const fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT || root);
const video=await makeVideoFixture(fixture.origin);
async function openVisibleFile(page, kind) {
  const id=await page.evaluate(kind=>{
    const bounds=matchMedia('(max-width: 900px)').matches
      ?document.querySelector('.workspace').getBoundingClientRect():{top:0,bottom:innerHeight};
    return __test.state.files.find(file=>{
      const card=document.querySelector(`.file-card[data-file-id="${file.id}"]`),r=card?.getBoundingClientRect();
      return file.mediaKind===kind&&r&&r.top>=bounds.top&&r.bottom<=bounds.bottom;
    })?.id;
  },kind);
  assert.ok(id,'a fully visible '+kind+' card is required');
  await page.locator(`.file-card[data-file-id="${id}"] > button:first-child`).click();
}
try {
  for(const [name,engine,launch] of engines) {
    const browser=await engine.launch({headless:true,...launch});
    try {
      for(const mobile of [false,true]) {
        const context=await browser.newContext({viewport:mobile?{width:390,height:740}:{width:1280,height:900}});
        if(mobile) {
          await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));
          await context.addCookies([{name:'standalone',value:'1',url:fixture.origin}]);
        }
        const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await preparePage(page,fixture.origin,320);
        await page.evaluate(video=>{
          __test.videoFixture(URL.createObjectURL(new Blob([new Uint8Array(video.bytes)],{type:video.type})));
          __test.state.files.forEach(f=>{f.hasThumbnail=false;if(f.mediaKind==='video')f.mimeType=video.type;});
        },video);
        let reloads=0;
        const records=await page.evaluate(()=>__test.state.files.map(f=>({...f,fileKey:undefined,cryptoVersion:0})));
        await page.route('**/cloud/api/**',async route=>{
          if(route.request().url().includes('/items?'))reloads++;
          await route.fulfill({json:{folders:[],files:records,breadcrumbs:[],folderSummary:null}});
        });
        const outcomes=[];
        for(const action of ['x','back','escape','backdrop']) {
          await page.evaluate(()=>__test.scrollAppTo({top:5000,left:0,behavior:'auto'}));
          const position=await page.evaluate(()=>__test.appScrollPosition().y);
          await openVisibleFile(page,'video');
          await page.waitForFunction(()=>document.querySelector('#preview-dialog').open);
          let playback='not-requested';
          if(!before) {
            playback=await page.locator('#preview-stage video').evaluate(async v=>{try{v.muted=true;await v.play();return 'playing';}catch(e){return e.name;}});
            if(playback==='playing')await page.waitForFunction(()=>document.querySelector('#preview-stage video')?.currentTime>0.05);
            else {assert.equal(name,'webkit');assert.equal(playback,'NotSupportedError');}
          }
          const prevReloads=reloads;
          if(action==='x')await page.locator('#preview-dialog .dialog-close').click();
          if(action==='back')await page.goBack();
          if(action==='escape')await page.keyboard.press('Escape');
          if(action==='backdrop')await page.mouse.click(2,2);
          await page.waitForFunction(()=>!document.querySelector('#preview-dialog').open&&!history.state?.previewId);
          await page.waitForTimeout(250);
          const outcome=await page.evaluate(()=>({position:__test.appScrollPosition().y,id:__test.state.previewFileId,token:__test.state.previewMediaToken,pending:!!__test.state.previewClosePending}));
          outcomes.push({action,playback,expected:position,...outcome,reloads:reloads-prevReloads});
          if(!before) {assert.ok(Math.abs(outcome.position-position)<=2,JSON.stringify(outcomes));assert.equal(reloads,prevReloads);assert.equal(outcome.id,null);assert.equal(outcome.token,'');assert.equal(outcome.pending,false);}
        }
        if(!before) {
          await page.evaluate(()=>__test.photoFixture());
          for(const action of ['x','back','escape','backdrop']) {
            await page.evaluate(()=>__test.scrollAppTo({top:5000,left:0,behavior:'auto'}));
            await openVisibleFile(page,'image');
            await page.waitForFunction(()=>document.querySelector('#preview-stage img')?.naturalWidth>0);
            if(action==='x')await page.locator('#preview-dialog .dialog-close').click();
            if(action==='back')await page.goBack();
            if(action==='escape')await page.keyboard.press('Escape');
            if(action==='backdrop')await page.mouse.click(2,2);
            await page.waitForFunction(()=>!document.querySelector('#preview-dialog').open&&!history.state?.previewId);
            await page.waitForTimeout(150);
            assert.ok(Math.abs(await page.evaluate(()=>__test.appScrollPosition().y)-5000)<=2,action+' photo');
          }
          await page.evaluate(async()=>{
            await __test.openPreview(__test.state.files.find(f=>f.mediaKind==='image'));
            // An offline preview can coexist with a list selection; closing it
            // must not consume only the selection branch and leave the dialog open.
            __test.state.selectedFiles.set(__test.state.files[0].id,__test.state.files[0]);
            const back=history.back.bind(history);globalThis.__backCalls=0;history.back=()=>{__backCalls++;back();};
            document.querySelector('#preview-dialog .dialog-close').click();document.querySelector('#preview-dialog .dialog-close').click();
          });
          await page.waitForFunction(()=>!document.querySelector('#preview-dialog').open&&!history.state?.previewId);
          assert.equal(await page.evaluate(()=>__backCalls),1,'double close must request one history traversal');
        }
        console.log(before?'BEFORE preview':'PASS preview',name,{mobile,outcomes});
        assert.deepEqual(errors,[]);
        await context.close();
      }
    } finally {await browser.close();}
  }
} finally {await fixture.close();}
