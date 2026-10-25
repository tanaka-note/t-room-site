import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { engines, root, startUIFixture, preparePage } from "./ui-fixture.mjs";

const fixture = await startUIFixture();
async function photo(page,id) {
  await page.waitForFunction(id => __test.state.previewFileId===id && document.querySelector("#preview-stage img")?.naturalWidth>0,id);
}
async function fullscreen(page,active) {
  await page.waitForFunction(active => Boolean(document.fullscreenElement || document.webkitFullscreenElement)===active
    && document.querySelector("#photo-fullscreen-toggle").getAttribute("aria-pressed")===String(active),active);
  assert.equal(await page.locator("#photo-fullscreen-toggle").getAttribute("aria-pressed"),String(active));
}
try {
  for (const [name,engine,launch] of engines) {
    const browser=await engine.launch({headless:true,...launch});
    try {
      const page=await browser.newPage({viewport:{width:1280,height:800},hasTouch:true});
      const errors=[];page.on("pageerror",e=>errors.push(e.message));
      await preparePage(page,fixture.origin,40);
      await page.route("**/cloud/api/**",route=>route.fulfill({json:{fileIds:[],folderIds:[]}}));
      await page.evaluate(()=>__test.photoFixture());
      await page.locator('.file-card[data-file-id="11"] > button:first-child').click();await photo(page,11);
      const origin=await page.evaluate(()=>__test.appScrollPosition().y);
      await page.locator("#preview-select").click();
      await page.locator("#photo-fullscreen-toggle").click();await fullscreen(page,true);
      const bounds=await page.evaluate(()=>{
        const r=document.querySelector("#preview-stage-wrap").getBoundingClientRect();
        const img=document.querySelector("#preview-stage img").getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,imageFits:img.width<=r.width+1&&img.height<=r.height+1};
      });
      assert.ok(Math.abs(bounds.x)<1&&Math.abs(bounds.y)<1&&Math.abs(bounds.width-bounds.vw)<1&&Math.abs(bounds.height-bounds.vh)<1,JSON.stringify(bounds));
      assert.ok(bounds.imageFits);
      for(let i=0;i<5;i++) {
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(()=>document.querySelector("#preview-stage-wrap").contains(document.activeElement)),true,"fullscreen focus must stay in visible controls");
      }
      await page.locator("#photo-zoom-toggle").click();
      assert.equal(await page.locator("#photo-zoom-toggle").getAttribute("aria-pressed"),"true");
      const beforePan=await page.locator("#preview-stage img").evaluate(img=>getComputedStyle(img).transform);
      const image=await page.locator("#preview-stage").boundingBox();
      await page.mouse.move(image.x+image.width/2,image.y+image.height/2);await page.mouse.down();
      await page.mouse.move(image.x+image.width/2+120,image.y+image.height/2);await page.mouse.up();
      assert.equal(await page.evaluate(()=>__test.state.previewFileId),11);
      assert.notEqual(await page.locator("#preview-stage img").evaluate(img=>getComputedStyle(img).transform),beforePan);
      await page.keyboard.press("ArrowRight");await photo(page,13);await fullscreen(page,true);
      assert.equal(await page.locator("#photo-zoom-toggle").getAttribute("aria-pressed"),"false");
      if(process.env.TROOM_PHOTO_SCREENSHOTS){await mkdir(resolve(root,"tmp/photo-fullscreen"),{recursive:true});await page.screenshot({path:resolve(root,`tmp/photo-fullscreen/${name}.png`)});}
      await page.locator("#photo-fullscreen-toggle").click();await fullscreen(page,false);
      assert.equal(await page.locator("#preview-dialog").isVisible(),true);
      assert.equal(await page.locator("#photo-fullscreen-toggle").evaluate(b=>document.activeElement===b),true);
      await page.locator("#photo-fullscreen-toggle").focus();await page.keyboard.press("Enter");await fullscreen(page,true);
      await page.keyboard.press("Escape");await fullscreen(page,false);
      assert.equal(await page.locator("#preview-dialog").isVisible(),true,"first Escape exits fullscreen only");
      assert.equal(await page.locator("#preview-select").evaluate(b=>b.closest(".preview-actions").inert),false);
      await page.keyboard.press("Escape");
      await page.waitForFunction(()=>!document.querySelector("#preview-dialog").open&&!__test.state.previewClosePending);
      assert.deepEqual(await page.evaluate(()=>__test.selectedItems().files.map(f=>f.id)),[11]);
      assert.ok(Math.abs(await page.evaluate(()=>__test.appScrollPosition().y)-origin)<2);
      await page.locator("#selection-clear").click();await page.waitForFunction(()=>!__test.state.selectionClearBackPending);

      // Closing through browser Back while fullscreen entry is still pending
      // must exit fullscreen and must not reopen the preview afterwards.
      await page.evaluate(()=>__test.openPreview(__test.state.files[0]));await photo(page,1);
      await page.evaluate(()=>{
        const container=document.querySelector("#preview-stage-wrap");
        globalThis.__realPhotoFullscreen=(container.requestFullscreen||container.webkitRequestFullscreen).bind(container);
        container.requestFullscreen=()=>__realPhotoFullscreen().then(()=>new Promise(resolve=>{globalThis.__finishPhotoEntry=resolve;}));
      });
      await page.locator("#photo-fullscreen-toggle").click();await fullscreen(page,true);
      await page.waitForFunction(()=>typeof __finishPhotoEntry==="function");
      await page.goBack();
      await page.waitForFunction(()=>!document.querySelector("#preview-dialog").open);
      await fullscreen(page,false);
      await page.evaluate(()=>__finishPhotoEntry());
      await page.waitForFunction(()=>!document.querySelector("#photo-fullscreen-toggle").disabled);
      assert.equal(await page.locator("#preview-dialog").isVisible(),false);

      // The video player uses the same container but owns its own fullscreen.
      // Photo-only cleanup must not immediately exit a video's fullscreen.
      await page.evaluate(()=>{
        document.querySelector("#preview-stage-wrap").requestFullscreen=__realPhotoFullscreen;
        __test.unavailableVideo();
        return __test.openPreview(__test.state.files[1]);
      });
      await page.locator(".preview-player-fullscreen").click();
      await page.waitForFunction(()=>Boolean(document.fullscreenElement||document.webkitFullscreenElement));
      await page.waitForTimeout(80);
      assert.equal(await page.locator("#photo-fullscreen-toggle").isVisible(),false);
      assert.equal(await page.evaluate(()=>Boolean(document.fullscreenElement||document.webkitFullscreenElement)),true);
      await page.locator(".preview-player-fullscreen").click();
      await page.waitForFunction(()=>!document.fullscreenElement&&!document.webkitFullscreenElement);
      await page.locator("#preview-close").click();
      await page.waitForFunction(()=>!document.querySelector("#preview-dialog").open&&!__test.state.previewClosePending);

      // Rejected and unsupported requests preserve the ordinary viewer.
      await page.evaluate(()=>{
        document.querySelector("#preview-stage-wrap").requestFullscreen=async()=>{throw new DOMException("fixture denied","NotAllowedError");};
        return __test.openPreview(__test.state.files[0]);
      });await photo(page,1);
      await page.locator("#photo-fullscreen-toggle").click();
      await page.waitForFunction(()=>!document.querySelector("#preview-notice").hidden);
      assert.equal(await page.locator("#preview-dialog").isVisible(),true);await fullscreen(page,false);
      await page.evaluate(()=>{
        Object.defineProperty(document,"fullscreenEnabled",{value:false,configurable:true});
        Object.defineProperty(document,"webkitFullscreenEnabled",{value:false,configurable:true});
        return __test.openPreview(__test.state.files[0],{pushHistory:false});
      });await photo(page,1);
      assert.equal(await page.locator("#photo-fullscreen-toggle").isVisible(),false);
      await page.locator("#photo-zoom-toggle").click();
      assert.equal(await page.locator("#photo-zoom-toggle").getAttribute("aria-pressed"),"true");
      assert.deepEqual(errors,[]);
      console.log("PASS native photo fullscreen, zoom/pan/navigation, focus, Escape, Back race, selection and fallback",name);
    } finally {await browser.close();}
  }
} finally {await fixture.close();}
