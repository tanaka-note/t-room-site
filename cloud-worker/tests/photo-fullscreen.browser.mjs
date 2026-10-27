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
const transform = page => page.locator("#preview-stage img").evaluate(img => {
  const matrix = new DOMMatrix(getComputedStyle(img).transform);
  return { scale: matrix.a, x: matrix.e, y: matrix.f };
});
async function wheelZoom(page) {
  const box = await page.locator("#preview-stage").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const scroll = await page.evaluate(() => __test.appScrollPosition().y);
  await page.mouse.move(cx,cy+40);
  await page.mouse.wheel(0,-100);
  await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector("#preview-stage img")).transform).a > 1);
  const zoomed = await transform(page);
  assert.ok(Math.abs(zoomed.y - 40 * (1 - zoomed.scale)) < .01,"wheel zoom keeps the point under the cursor fixed");
  assert.equal(await page.locator("#photo-zoom-toggle").getAttribute("aria-pressed"),"true");
  await page.mouse.wheel(0,120);
  await page.waitForFunction(() => document.querySelector("#photo-zoom-toggle").getAttribute("aria-pressed") === "false");
  assert.deepEqual(await transform(page),{scale:1,x:0,y:0});
  assert.equal(await page.evaluate(() => __test.appScrollPosition().y),scroll,"wheel zoom must not scroll the underlying listing");

  const dispatch = init => page.evaluate(init => {
    const stage = document.querySelector("#preview-stage");
    const box = stage.getBoundingClientRect();
    const event = new WheelEvent("wheel",{bubbles:true,cancelable:true,clientX:box.x+box.width/2,clientY:box.y+box.height/2,...init});
    stage.dispatchEvent(event);
    return { prevented:event.defaultPrevented, scale:new DOMMatrix(getComputedStyle(stage.querySelector("img")).transform).a };
  },init);
  const scales = [];
  for (const init of [{deltaY:-16},{deltaY:-1,deltaMode:1},{deltaY:-16/box.height,deltaMode:2}]) {
    const result = await dispatch(init);
    assert.equal(result.prevented,true);
    scales.push(result.scale);
    await page.locator("#photo-zoom-toggle").click();
  }
  assert.ok(scales.every(scale => scale > 1 && Math.abs(scale-scales[0]) < .00001),"pixel, line and page deltas have equivalent sensitivity");
  for (const init of [{deltaY:0},{deltaX:120,deltaY:-1},{deltaY:-120,ctrlKey:true},{deltaY:-120,metaKey:true},{deltaY:-120,shiftKey:true},{deltaY:-120,cancelable:false}]) {
    assert.deepEqual(await dispatch(init),{prevented:false,scale:1},"unhandled wheel input keeps its default behavior");
  }
  await page.mouse.move(cx,cy); await page.mouse.down();
  assert.deepEqual(await dispatch({deltaY:-120}),{prevented:false,scale:1},"wheel input must not interrupt a pointer gesture");
  await page.mouse.up();
  for (let i=0;i<12;i++) await dispatch({deltaY:-100000});
  assert.equal((await transform(page)).scale,6,"wheel enlargement is bounded");
  assert.deepEqual(await dispatch({deltaY:-120}),{prevented:true,scale:6});
  for (let i=0;i<12;i++) await dispatch({deltaY:100000});
  assert.deepEqual(await transform(page),{scale:1,x:0,y:0});
  assert.deepEqual(await dispatch({deltaY:120}),{prevented:true,scale:1});
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
      await wheelZoom(page);
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
      const afterExit=await transform(page);
      await page.locator("#preview-stage").dispatchEvent("wheel",{deltaY:-120,cancelable:true});
      assert.deepEqual(await transform(page),afterExit,"wheel zoom stops when fullscreen exits");
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
      console.log("PASS native photo fullscreen, wheel zoom, zoom/pan/navigation, focus, Escape, Back race, selection and fallback",name);
    } finally {await browser.close();}
  }
} finally {await fixture.close();}
