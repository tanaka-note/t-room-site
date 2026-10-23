import assert from "node:assert/strict";
import { engines, startUIFixture, preparePage } from "./ui-fixture.mjs";
const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try {
    const first = "00000000-0000-0000-0000-000000000001", second = "00000000-0000-0000-0000-000000000002", fresh = "00000000-0000-0000-0000-000000000003";
    let jobs = [], accepts = 0, statusReads = 0, unclaimed = true;
    const retries = [];
    const file = { id: 1, folderId: 7, name: "fixture.txt", mediaKind: "document", mimeType: "text/plain", cryptoVersion: 0, sizeBytes: 100 };
    async function openTrash() {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.clock.install();
      await page.route("**/cloud/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        let data = {};
        if (path.endsWith("/trash") && route.request().method() === "DELETE") {
          const job = { id: ++accepts === 1 ? first : fresh, status: "queued", phase: "queued", totalFiles: 100, totalFolders: 2, deletedFiles: 0, deletedFolders: 0, createdAt: 1792700000000 };
          jobs.unshift(job); unclaimed = false; data = { ok: true, job };
        } else if (path.endsWith("/retry")) {
          const id = path.split("/").at(-2); retries.push(id);
          const job = jobs.find(job => job.id === id); job.status = job.phase = "queued"; data = { ok: true, job };
        } else if (path.endsWith("/trash/jobs")) { statusReads++; data = { jobs }; }
        else if (path.endsWith("/trash")) data = { job: jobs[0] || null, jobs, folders: [], files: [...(jobs.some(job => job.status !== "completed") ? [{ ...file, purging: true }] : []), ...(unclaimed ? [{ ...file, id: 2, purging: false }] : [])] };
        else if (path.endsWith("/usage")) data = { usage: {} };
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      });
      await preparePage(page, fixture.origin, 0);
      await page.evaluate(async () => { __test.state.view = "trash"; await __test.loadItems(); });
      return page;
    }
    const selector = id => `[data-trash-job-id="${id}"]`;
    async function poll(page, text) {
      await page.clock.runFor(5001);
      await page.waitForFunction(text => document.querySelector("#trash-deletion-jobs").textContent.includes(text), text);
    }
    let page = await openTrash();
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#empty-trash-button").click();
    await page.waitForFunction(() => document.querySelector("#trash-deletion-jobs").textContent.includes("受付済み"));
    assert.equal(accepts, 1);
    assert.match(await page.locator("#trash-deletion-status").textContent(), /閉じても続行/);
    await page.close();
    const original = jobs[0]; original.status = original.phase = "running"; original.deletedFiles = 80;
    page = await openTrash();
    assert.equal(accepts, 1);
    assert.match(await page.locator(selector(first)).textContent(), /削除処理中.*80 \/ 102/);
    await page.locator(".file-card").first().click();
    assert.equal(await page.locator("#trash-dialog").evaluate(dialog => dialog.open), false);
    original.phase = "waiting"; await poll(page, "中断・再開待ち");
    original.status = original.phase = "failed";
    jobs.push({ ...original, id: second, totalFiles: 2, totalFolders: 0, deletedFiles: 0 }); unclaimed = true;
    await poll(page, "一部失敗");
    assert.equal(await page.locator("#trash-deletion-jobs button").count(), 2);
    assert.equal(await page.locator("#empty-trash-button").isEnabled(), true);
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#empty-trash-button").click();
    await page.waitForFunction(() => document.querySelectorAll("#trash-deletion-jobs button:disabled").length === 2);
    assert.equal(accepts, 2); assert.deepEqual(retries, []);
    const newJob = jobs.find(job => job.id === fresh); newJob.status = newJob.phase = "completed";
    await poll(page, "完了");
    await page.waitForFunction(() => document.querySelectorAll("#trash-deletion-jobs button:disabled").length === 0);
    page.once("dialog", dialog => dialog.accept());
    await page.locator(selector(second)).locator("button").click();
    await page.waitForFunction(id => document.querySelector(`[data-trash-job-id="${id}"]`).textContent.includes("受付済み"), second);
    assert.deepEqual(retries, [second]); assert.equal(original.status, "failed");
    jobs = [{ ...original, status: "completed", phase: "completed", deletedFiles: 100, deletedFolders: 2 }];
    await poll(page, "完了");
    await page.waitForFunction(() => !document.querySelector("#trash-deletion-jobs").textContent.includes("受付済み"));
    assert.equal(await page.locator("#empty-trash-button").isVisible(), false);
    const reads = statusReads; await page.clock.runFor(15000); assert.equal(statusReads, reads);
    await page.close();
    console.log(`${name}: close/reopen, five phases, multiple failed jobs, separate new deletion/ID retry, active slot and completion passed`);
  } finally { await browser.close(); }
} } finally { await fixture.close(); }
