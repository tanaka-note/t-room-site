import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';

const fixture=await startUIFixture();
try { for(const [name,engine,launch] of engines) {
  const browser=await engine.launch({headless:true,...launch});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],failed=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('requestfailed',request=>failed.push(request.url()));
    await preparePage(page,fixture.origin,6);
    const bytes=await page.evaluate(async()=>{
      __test.resetEncryptedThumbnailLoading();
      __test.state.folderId=7;
      __test.state.breadcrumbs=[{id:7,isUnlocked:true}];
      __test.state.crypto.folderKeys.set(7,__thumb.key);
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      canvas.getContext('2d').fillStyle='#248080';canvas.getContext('2d').fillRect(0,0,320,180);
      const original=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const plain=new Uint8Array(await original.arrayBuffer()),envelopes=[];
      for(const file of __test.state.files) {
        file.fileKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
        Object.assign(file,{mediaKind:'image',mimeType:'image/png',folderId:7,hasThumbnail:false,
          sizeBytes:plain.length,chunkSizeBytes:8192,chunkCount:1});
        envelopes.push([...await TRoomCrypto.encryptFileChunk(file.fileKey,plain,0)]);
      }
      __test.renderItems();
      for(const file of __test.state.files.slice(0,2)) {
        await __test.installThumbnailBlob(file,document.querySelector(`.file-card[data-file-id="${file.id}"] .thumb`),__thumb.blob,new AbortController().signal);
      }
      globalThis.__loadingStats={cacheStarted:0,cacheWrites:0,attaches:0};
      const attach=TCloudPhotoViewer.attach;
      globalThis.TCloudPhotoViewer={...TCloudPhotoViewer,attach(...args){__loadingStats.attaches++;return attach(...args);}};
      const gate=new Promise(resolve=>{globalThis.__releasePhotoCache=resolve;});
      globalThis.TCloudOffline={...TCloudOffline,supported:()=>true,getChunk:async()=>null,
        beginEntry:async record=>{if(record.fileId===1){__loadingStats.cacheStarted++;await gate;}},
        putChunk:async()=>{__loadingStats.cacheWrites++;}};
      return envelopes;
    });
    const requests=[],held=new Map();
    await page.route('**/cloud/api/**',async route=>{
      const match=/\/files\/(\d+)\/view/.exec(route.request().url());
      assert.ok(match,'photo opening adds no thumbnail or metadata request');
      const id=Number(match[1]);requests.push(id);
      assert.equal(route.request().headers().range,`bytes=0-${bytes[id-1].length-1}`);
      if([1,2,4,5].includes(id))await new Promise(resolve=>held.set(id,resolve));
      await route.fulfill({status:206,contentType:'application/octet-stream',body:Buffer.from(bytes[id-1])}).catch(()=>{});
    });
    const ready=async(id,quality)=>page.waitForFunction(({id,quality})=>__test.state.previewFileId===id
      &&document.querySelector('#preview-stage img')?.dataset.photoQuality===quality
      &&document.querySelector('#preview-stage img')?.naturalWidth>0,{id,quality});
    const release=async id=>{assert.ok(held.has(id),`missing held request ${id}`);held.get(id)();held.delete(id);};
    const waitHeld=async id=>{
      const deadline=Date.now()+3000;
      while(!held.has(id)){assert.ok(Date.now()<deadline,`photo ${id} never fetched its original`);await new Promise(r=>setTimeout(r,10));}
    };
    const waitFailed=async id=>{
      const deadline=Date.now()+3000;
      while(!failed.some(url=>url.includes(`/files/${id}/view`))){assert.ok(Date.now()<deadline,`photo ${id} was not cancelled`);await new Promise(r=>setTimeout(r,10));}
    };

    await page.evaluate(()=>{globalThis.__firstPhoto=__test.openPreview(__test.state.files[0]);});
    await ready(1,'thumbnail');await waitHeld(1);
    assert.equal(await page.evaluate(()=>__loadingStats.cacheStarted),1);
    await page.locator('#photo-zoom-toggle').click();
    assert.equal(await page.locator('#photo-zoom-toggle').getAttribute('aria-pressed'),'true');
    const fullscreen=await page.locator('#photo-fullscreen-toggle').isVisible();
    if(fullscreen)await page.locator('#photo-fullscreen-toggle').click();
    const stageBox=await page.locator('#preview-stage').boundingBox();
    await page.mouse.move(stageBox.x+stageBox.width/2,stageBox.y+stageBox.height/2);
    await page.mouse.down();await page.mouse.move(stageBox.x+stageBox.width/2+40,stageBox.y+stageBox.height/2+25);await page.mouse.up();
    const pan=await page.locator('#preview-stage img').evaluate(img=>img.style.transform);
    await release(1);await ready(1,'original');
    assert.equal(await page.locator('#preview-stage img').evaluate(img=>img.naturalWidth),320);
    assert.equal(await page.locator('#photo-zoom-toggle').getAttribute('aria-pressed'),'true','upgrade preserves zoom');
    assert.equal(await page.locator('#preview-stage img').evaluate(img=>img.style.transform),pan,'upgrade preserves pan');
    if(fullscreen) {
      assert.equal(await page.evaluate(()=>(document.fullscreenElement||document.webkitFullscreenElement)?.id),'preview-stage-wrap');
      await page.locator('#photo-fullscreen-toggle').click();
    }
    assert.equal(await page.evaluate(()=>__loadingStats.attaches),1,'one set of gestures and observer survives the upgrade');
    assert.equal(await page.evaluate(()=>__loadingStats.cacheWrites),0,'original renders while cache preparation is still held');
    assert.equal(await page.locator('#preview-notice').isVisible(),false);
    await page.evaluate(()=>__releasePhotoCache());
    await page.waitForFunction(()=>__loadingStats.cacheWrites===1);

    await page.keyboard.press('ArrowRight');await ready(2,'thumbnail');await waitHeld(2);
    await page.locator('#preview-next').click();await ready(3,'original');
    await waitFailed(2);
    assert.ok(failed.some(url=>url.includes('/files/2/view')),'switch aborts the previous original fetch');
    await release(2);
    assert.equal(await page.evaluate(()=>__test.state.previewFileId),3);
    assert.equal(await page.locator('#photo-zoom-toggle').getAttribute('aria-pressed'),'false');

    await page.locator('#preview-next').click();await waitHeld(4);
    await page.locator('#preview-close').click();
    await page.waitForFunction(()=>__test.state.previewFileId===null&&!__test.state.previewClosePending);
    await waitFailed(4);
    assert.ok(failed.some(url=>url.includes('/files/4/view')),'close aborts the original fetch');
    await release(4);
    assert.equal(await page.locator('#preview-dialog').isVisible(),false);

    // A late thumbnail decode cannot downgrade an already displayed original.
    await page.evaluate(()=>{
      const NativeImage=Image;globalThis.__restorePhotoImage=()=>{globalThis.Image=NativeImage;};
      globalThis.Image=function(...args){
        const image=new NativeImage(...args),add=image.addEventListener.bind(image);
        image.addEventListener=(type,listener,options)=>add(type,
          type==='load'&&image.dataset.photoQuality==='thumbnail'?(...events)=>setTimeout(()=>listener(...events),200):listener,options);
        return image;
      };
      void __test.openPreview(__test.state.files[0]);
    });
    await waitHeld(1);await release(1);await ready(1,'original');
    await page.waitForTimeout(230);
    assert.equal(await page.locator('#preview-stage img').getAttribute('data-photo-quality'),'original');
    await page.evaluate(()=>__restorePhotoImage());

    bytes[5]=await page.evaluate(async()=>{
      const file=__test.state.files[5],plain=new TextEncoder().encode('invalid image fixture');
      file.sizeBytes=plain.length;
      await __test.installThumbnailBlob(file,document.querySelector('.file-card[data-file-id="6"] .thumb'),__thumb.blob,new AbortController().signal);
      return [...await TRoomCrypto.encryptFileChunk(file.fileKey,plain,0)];
    });
    await page.evaluate(()=>{void __test.openPreview(__test.state.files[5],{pushHistory:false});});
    await ready(6,'thumbnail');
    await page.waitForFunction(()=>document.querySelector('#preview-stage').dataset.photoOriginalState==='error');
    assert.equal(await page.locator('#preview-stage img').getAttribute('data-photo-quality'),'thumbnail');
    assert.match(await page.locator('#preview-notice').innerText(),/元の写真を表示できませんでした/);

    await page.evaluate(()=>{void __test.openPreview(__test.state.files[4]);});await waitHeld(5);
    await page.evaluate(()=>__test.releaseSessionState());
    await waitFailed(5);
    assert.ok(failed.some(url=>url.includes('/files/5/view')),'session release aborts the original fetch');
    await release(5);
    await page.waitForFunction(()=>document.querySelector('#preview-stage').childElementCount===0);
    assert.equal(await page.evaluate(()=>__test.state.previewUrl),'');
    assert.deepEqual(requests,[1,2,3,4,1,6,5]);
    assert.deepEqual(errors,[]);
    await page.close();
    console.log('PASS photo progressive loading',name,'early thumbnail, original before cache gate, retained zoom, switch/close/logout aborts, no extra requests');
  } finally {await browser.close();}
} } finally {await fixture.close();}
