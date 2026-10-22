import assert from "node:assert/strict";
import { engines, startUIFixture, preparePage } from "./ui-fixture.mjs";

const fixture = await startUIFixture();
try {
  for (const [name, engine, launch] of engines) {
    const browser = await engine.launch({ headless: true, ...launch });
    try {
      let job = null;
      let accepts = 0;
      let retries = 0;
      let statusReads = 0;
      const file = { id: 1, folderId: 7, name: "fixture.txt", mediaKind: "document", mimeType: "text/plain", cryptoVersion: 0, sizeBytes: 100 };
      async function openTrash() {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.clock.install();
        await page.route("**/cloud/api/**", async route => {
          const path = new URL(route.request().url()).pathname;
          let data = {};
          if (path.endsWith("/trash") && route.request().method() === "DELETE") {
            accepts++;
            job ||= { id: "persisted-job", status: "queued", totalFiles: 100, totalFolders: 2, deletedFiles: 0, deletedFolders: 0 };
            data = { ok: true, job };
          } else if (path.endsWith("/trash/job/retry")) {
            retries++; job = { ...job, status: "queued" }; data = { ok: true, job };
          } else if (path.endsWith("/trash/job")) {
            statusReads++; data = { job };
          } else if (path.endsWith("/trash")) data = { job, folders: [], files: job?.status === "completed" ? [] : [{ ...file, purging: Boolean(job) }] };
          else if (path.endsWith("/usage")) data = { usage: {} };
          await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
        });
        await preparePage(page, fixture.origin, 0);
        await page.evaluate(async () => { __test.state.view = "trash"; await __test.loadItems(); });
        return page;
      }
      let page = await openTrash();
      page.once("dialog", dialog => dialog.accept());
      await page.locator("#empty-trash-button").click();
      await page.waitForFunction(() => document.querySelector("#empty-trash-button").textContent === "クラウドで削除中");
      assert.equal(accepts, 1, "a single write accepts all work");
      assert.equal(await page.locator("#empty-trash-button").isDisabled(), true);
      assert.match(await page.locator("#trash-deletion-status").textContent(), /閉じても続行/);
      await page.close();

      // The saved job survives the page. Opening it does not reissue deletion.
      job = { ...job, status: "running", deletedFiles: 80 };
      page = await openTrash();
      assert.equal(accepts, 1);
      assert.match(await page.locator("#trash-deletion-status").textContent(), /80 \/ 102/);
      const card = page.locator(".file-card").first();
      await card.click();
      assert.equal(await page.locator("#trash-dialog").evaluate(dialog => dialog.open), false, "accepted data cannot show restore actions");

      job = { ...job, status: "failed", deletedFiles: 99 };
      await page.clock.runFor(5001);
      await page.waitForFunction(() => document.querySelector("#empty-trash-button").textContent === "削除を再試行");
      assert.ok(statusReads > 0);
      assert.match(await page.locator("#trash-deletion-status").textContent(), /一部の削除に失敗/);
      page.once("dialog", dialog => dialog.accept());
      await page.locator("#empty-trash-button").click();
      await page.waitForFunction(() => document.querySelector("#empty-trash-button").disabled);
      assert.equal(retries, 1);
      assert.equal(accepts, 1);

      job = { ...job, status: "completed", deletedFiles: 100, deletedFolders: 2 };
      await page.clock.runFor(5001);
      await page.waitForFunction(() => document.querySelector("#trash-deletion-status").textContent.includes("完了"));
      assert.equal(await page.locator("#empty-trash-button").isVisible(), false);
      const readsAfterCompletion = statusReads;
      await page.clock.runFor(15000);
      assert.equal(statusReads, readsAfterCompletion, "completed jobs stop polling");
      await page.close();
      console.log(`${name}: trash acceptance, close/reopen progress, restore protection, failure/retry and completion passed`);
    } finally { await browser.close(); }
  }
} finally { await fixture.close(); }
