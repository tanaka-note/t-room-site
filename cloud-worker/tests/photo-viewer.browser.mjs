import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { engines, root, startUIFixture, preparePage } from "./ui-fixture.mjs";

const fixture = await startUIFixture();
async function ready(page, id) {
  await page.waitForFunction(id => Number(document.querySelector(".file-card")?.dataset.fileId) > 0
    && __test.state.previewFileId === id && document.querySelector("#preview-stage img")?.naturalWidth > 0, id);
}
async function pointer(page, type, id, x, y) {
  await page.locator("#preview-stage").dispatchEvent(type, {
    pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1
  });
}
async function swipe(page) {
  const box = await page.locator("#preview-stage").boundingBox();
  await pointer(page, "pointerdown", 1, box.x + box.width * .8, box.y + box.height / 2);
  await pointer(page, "pointermove", 1, box.x + box.width * .2, box.y + box.height / 2);
  await pointer(page, "pointerup", 1, box.x + box.width * .2, box.y + box.height / 2);
}
const zoomed = page => page.locator("#photo-zoom-toggle").getAttribute("aria-pressed");
try {
  for (const [name, engine, launch] of engines) {
    for (const mobile of [false, true]) {
      const browser = await engine.launch({ headless: true, ...launch });
      try {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: true });
        const page = await context.newPage(), errors = [], downloads = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("download", download => downloads.push(download.suggestedFilename()));
        await preparePage(page, fixture.origin, 30);
        await page.route("**/cloud/api/**", route => route.fulfill({ json: {} }));
        await page.evaluate(() => __test.photoFixture());
        await page.evaluate(() => __test.openPreview(__test.state.files[0]));
        await ready(page, 1);
        assert.equal(await page.locator("#photo-details").getAttribute("open"), null);
        assert.equal(await page.locator("#delete-file-button").isVisible(), false);
        const layout = await page.evaluate(() => {
          const r = document.querySelector("#preview-dialog").getBoundingClientRect();
          const stage = document.querySelector("#preview-stage").getBoundingClientRect();
          const image = document.querySelector("#preview-stage img").getBoundingClientRect();
          return { width: r.width, height: r.height, imageHeight: stage.height, imageFitsStage: image.width <= stage.width + 1 && image.height <= stage.height + 1, viewport: innerHeight, horizontalOverflow: document.querySelector("#preview-dialog").scrollWidth > r.width + 1 };
        });
        if (mobile) { assert.ok(Math.abs(layout.width - 390) < 1); assert.ok(Math.abs(layout.height - 844) < 1); assert.ok(layout.imageHeight > 844 * .6, JSON.stringify(layout)); }
        assert.equal(layout.horizontalOverflow, false);
        assert.equal(layout.imageFitsStage,true,"normal-size photos must fit rather than crop in a wide desktop stage");
        const box = await page.locator("#preview-stage").boundingBox();
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

        // Chromium's input pipeline produces actual touch and pointer events.
        // WebKit uses synthetic pointer events because it has no CDP touch API.
        if (name === "chromium") {
          const cdp = await context.newCDPSession(page);
          const touches = async (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y })) });
          await touches("touchStart", [[1,cx-30,cy],[2,cx+30,cy]]);
          for (let n = 1; n <= 5; n++) await touches("touchMove", [[1,cx-30-n*12,cy],[2,cx+30+n*12,cy]]);
          await touches("touchEnd", []);
          await page.waitForFunction(() => document.querySelector("#preview-dialog").classList.contains("is-photo-zoomed"));
        } else {
          await pointer(page,"pointerdown",1,cx-30,cy); await pointer(page,"pointerdown",2,cx+30,cy);
          await pointer(page,"pointermove",1,cx-90,cy); await pointer(page,"pointermove",2,cx+90,cy);
          await pointer(page,"pointerup",1,cx-90,cy); await pointer(page,"pointerup",2,cx+90,cy);
        }
        assert.equal(await page.evaluate(() => __test.state.previewFileId), 1, "pinch must keep the same photo");
        assert.equal(await zoomed(page), "true");
        await swipe(page);
        assert.equal(await page.evaluate(() => __test.state.previewFileId), 1, "dragging a zoomed photo must pan");
        await page.locator("#photo-zoom-toggle").click();
        assert.equal(await zoomed(page), "false");
        await pointer(page,"pointerdown",1,cx,cy);
        await pointer(page,"pointercancel",1,cx-100,cy);
        await pointer(page,"pointerup",1,cx-100,cy);
        assert.equal(await page.evaluate(() => __test.state.previewFileId), 1, "cancelled drag must not navigate");
        await page.locator("#preview-stage img").dblclick();
        assert.equal(await zoomed(page), "true");
        await page.locator("#preview-stage img").dblclick();
        assert.equal(await zoomed(page), "false");
        await pointer(page,"pointerdown",1,cx,cy); await pointer(page,"pointerup",1,cx,cy);
        await pointer(page,"pointerdown",1,cx,cy); await pointer(page,"pointerup",1,cx,cy);
        assert.equal(await zoomed(page), "true", "double tap must zoom");
        await page.locator("#photo-zoom-toggle").focus();
        await page.keyboard.press("Enter");
        assert.equal(await zoomed(page), "false", "icon supports keyboard reset");
        await page.keyboard.press("Space");
        assert.equal(await zoomed(page), "true", "icon supports keyboard zoom");
        await page.keyboard.press("ArrowRight"); await ready(page,3);
        assert.equal(await zoomed(page), "false", "arrow navigation resets zoom even with a control focused");
        await page.keyboard.press("ArrowLeft"); await ready(page,1);
        const scaleBeforeWheel = await page.locator("#preview-stage img").evaluate(img => getComputedStyle(img).transform);
        await page.mouse.move(cx,cy); await page.mouse.wheel(0,-240);
        await page.waitForTimeout(80);
        assert.equal(await page.locator("#preview-stage img").evaluate(img => getComputedStyle(img).transform),scaleBeforeWheel,"wheel must not zoom");
        assert.equal(await page.locator("#photo-zoom-reset").count(),0,"numeric zoom UI is removed");
        await page.locator("#preview-select").click();
        await swipe(page); await ready(page,3);
        assert.equal(await zoomed(page), "false");
        await page.locator("#preview-select").click();
        assert.equal(await page.locator("#preview-download-selected").textContent(), "2件をダウンロード");
        if (process.env.TROOM_PHOTO_SCREENSHOTS) {
          await mkdir(resolve(root,"tmp/photo-viewer"), {recursive:true});
          await page.screenshot({path:resolve(root,`tmp/photo-viewer/${name}-${mobile ? "mobile" : "desktop"}.png`)});
        }
        if (mobile) {
          for (const size of [{width:320,height:568},{width:844,height:390},{width:390,height:844}]) {
            await page.setViewportSize(size);
            await page.locator("#preview-more summary").click();
            const menu = await page.locator(".preview-more-menu").boundingBox();
            assert.ok(menu.x >= 0 && menu.x + menu.width <= size.width + 1 && menu.y >= 0 && menu.y + menu.height <= size.height + 1, JSON.stringify({size,menu}));
            await page.locator("#preview-more summary").click();
          }
        }
        // Saving just the current photo must keep the multi-photo selection.
        await page.evaluate(() => { delete globalThis.showSaveFilePicker; delete globalThis.showDirectoryPicker; });
        const singleDownload = page.waitForEvent("download");
        await page.locator("#download-link").click();
        await singleDownload;
        await page.waitForFunction(() => !__test.state.downloadActive);
        assert.deepEqual(await page.evaluate(() => __test.selectedItems().files.map(f => f.id)),[1,3]);
        await page.locator("#download-close").click();
        await page.locator("#preview-close").click();
        await page.waitForFunction(() => !document.querySelector("#preview-dialog").open && !__test.state.previewClosePending);
        assert.deepEqual(await page.evaluate(() => __test.selectedItems().files.map(f => f.id)), [1,3]);
        if (mobile) {
          const selection = await page.locator("#selection-bar").boundingBox();
          assert.ok(selection.y > 844 / 2 && selection.y + selection.height <= 844);
          const checkbox = await page.locator(".file-select-button").first().boundingBox();
          assert.ok(checkbox.width >= 44 && checkbox.height >= 44);
        }
        await page.locator("#selection-clear").click();
        await page.waitForFunction(() => !__test.state.selectionClearBackPending);
        assert.equal(await page.locator("#selection-bar").isVisible(), false);
        await page.locator("#selection-mode-button").click();
        await page.goBack();
        await page.waitForFunction(() => !__test.state.selectionMode);
        assert.equal(await page.locator("#selection-bar").isVisible(), false, "empty selection mode must close with Back");
        await page.locator("#selection-mode-button").click();
        await page.locator('.file-card[data-file-id="1"] > button:first-child').click();
        assert.equal(await page.locator("#preview-dialog").isVisible(), false);
        await page.locator('.file-card[data-file-id="3"] > button:first-child').click();

        // A partial failure retains only failed photos for retry, including
        // errors during decryption; OS download handoff is not called "saved".
        await page.evaluate(() => {
          globalThis.TCloudMedia = { ...TCloudMedia, decryptToBlob: async file => {
            if (file.id === 3) throw new Error("fixture photo unavailable");
            return __thumb.blob;
          }};
        });
        await page.locator("#selection-download").click();
        await page.waitForFunction(() => !__test.state.downloadActive && document.querySelector("#download-summary").textContent.includes("エラー"));
        assert.equal(downloads.length,2);
        assert.deepEqual(await page.evaluate(() => __test.selectedItems().files.map(f => f.id)),[3]);
        await page.locator("#download-close").click();
        await page.evaluate(() => __test.photoFixture());
        await page.locator("#selection-download").click();
        await page.waitForFunction(() => !__test.state.downloadActive && document.querySelector("#download-summary").textContent.includes("ブラウザへ"));
        assert.equal(downloads.length,3);
        await page.locator("#download-close").click();
        await page.waitForFunction(() => !__test.state.selectionClearBackPending);
        assert.equal(await page.locator("#selection-bar").isVisible(),false);
        assert.deepEqual(errors,[]);
        console.log("PASS photo viewer",name,{mobile,pinch:name==="chromium"?"browser touch input":"synthetic pointers",selectionAndRetry:true});
        await context.close();
      } finally { await browser.close(); }
    }
  }
} finally { await fixture.close(); }
