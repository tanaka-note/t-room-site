import assert from "node:assert/strict";
import { engines, startUIFixture, preparePage } from "./ui-fixture.mjs";

const fixture = await startUIFixture();
try {
  for (const [name, engine, launch] of engines) {
    const browser = await engine.launch({ headless: true, ...launch });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 740 }, hasTouch: true });
      const errors = [], downloads = [], requests = [];
      let networkFailure = true;
      page.on("pageerror", e => errors.push(e.message));
      page.on("download", d => downloads.push(d.suggestedFilename()));
      await page.route("**/cloud/api/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/files/3/download")) {
          requests.push(3);
          await route.fulfill(networkFailure ? { status: 503, json: { error: "fixture network failure" } } : { body: "fixture photo", contentType: "image/png" });
        } else await route.fulfill({ json: {} });
      });
      await preparePage(page, fixture.origin, 10);
      await page.evaluate(() => {
        __test.photoFixture();
        delete globalThis.showSaveFilePicker; delete globalThis.showDirectoryPicker;
        globalThis.TCloudMedia = { ...TCloudMedia, decryptToBlob: async (file, key, endpoint, {signal} = {}) => {
          if (file.id !== 3) return __thumb.blob;
          globalThis.__blockedPhoto = true;
          return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("fixture cancelled", "AbortError")), {once:true}));
        }};
      });
      const choose = async ids => {
        for (const id of ids) await page.locator(`.file-card[data-file-id="${id}"] .file-select-button`).click();
      };
      const selected = () => page.evaluate(() => __test.selectedItems().files.map(f => f.id));
      const idle = () => page.waitForFunction(() => !__test.state.downloadActive && !__test.state.selectionClearBackPending);
      await choose([1,3,5]);
      const first = page.waitForEvent("download");
      await page.locator("#selection-download").click();
      await first; await page.waitForFunction(() => globalThis.__blockedPhoto);
      await page.locator("#download-cancel").click(); await idle();
      assert.deepEqual(await selected(), [3,5], "cancel keeps the active and unprocessed photos");
      assert.match(await page.locator("#download-summary").textContent(), /中止/);
      await page.locator("#download-close").click();
      await page.evaluate(() => __test.photoFixture());
      const retryDownloads = ["fixture 2", "fixture 4"].map(filename => page.waitForEvent("download", {predicate:d=>d.suggestedFilename().startsWith(filename)}));
      await page.locator("#selection-download").click(); await Promise.all(retryDownloads); await idle();
      assert.equal(downloads.length, 3, "the already completed photo is not downloaded again");
      assert.match(await page.locator("#download-summary").textContent(), /ブラウザへ/);
      await page.locator("#download-close").click();

      // A failed HTTP download is retried once and remains selected afterwards.
      await page.evaluate(() => { __test.state.files[2].cryptoVersion = 0; });
      await choose([1,3]);
      const beforeFailure = page.waitForEvent("download");
      await page.locator("#selection-download").click(); await beforeFailure; await idle();
      assert.equal(requests.length, 2);
      assert.deepEqual(await selected(), [3]);
      await page.locator("#download-close").click();
      networkFailure = false;
      const retried = page.waitForEvent("download");
      await page.locator("#selection-download").click(); await retried; await idle();
      assert.equal(requests.length, 3);
      assert.deepEqual(await selected(), []);
      await page.locator("#download-close").click();

      // Cancelling either OS picker must not open a transfer or lose selection.
      await page.evaluate(() => {
        __test.state.files[2].cryptoVersion = 1;
        globalThis.showDirectoryPicker = async () => { globalThis.__pickerCancelled = true; throw new DOMException("fixture cancelled", "AbortError"); };
      });
      await choose([1,3]);
      const beforePickers = downloads.length;
      await page.locator("#selection-download").click();
      await page.waitForFunction(() => globalThis.__pickerCancelled); await idle();
      assert.deepEqual(await selected(),[1,3]);
      assert.equal(await page.locator("#download-dialog").isVisible(),false);
      await page.locator('.file-card[data-file-id="3"] .file-select-button').click();
      await page.evaluate(() => {
        globalThis.__pickerCancelled = false;
        globalThis.showSaveFilePicker = globalThis.showDirectoryPicker;
      });
      await page.locator("#selection-download").click();
      await page.waitForFunction(() => globalThis.__pickerCancelled); await idle();
      assert.deepEqual(await selected(),[1]);
      assert.equal(downloads.length,beforePickers);

      // A local writable fixture exercises the UI's direct-save completion path.
      // Actual encrypted streaming is covered separately by Cloud media tests.
      await page.evaluate(() => {
        globalThis.__savedBytes = 0;
        globalThis.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async blob => { __savedBytes += blob.size; }, close: async () => {} }) });
        globalThis.TCloudMedia = { ...TCloudMedia, streamDownload: async (file,key,url,handle) => {
          const writer = await handle.createWritable(); await writer.write(__thumb.blob); await writer.close();
        }};
      });
      await page.locator("#selection-download").click();
      await page.waitForFunction(() => globalThis.__savedBytes > 0); await idle();
      assert.equal(await page.locator("#download-dialog").isVisible(),false);
      assert.match(await page.locator("#download-summary").textContent(),/保存が完了/);
      assert.equal(downloads.length,beforePickers);
      assert.deepEqual(await selected(),[]);
      assert.deepEqual(errors,[]);
      console.log("PASS photo cancellation, HTTP retry, picker cancellation and direct-save distinction",name);
    } finally { await browser.close(); }
  }
} finally { await fixture.close(); }
