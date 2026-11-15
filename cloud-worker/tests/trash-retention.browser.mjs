import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { engines, startUIFixture, preparePage, root } from "./ui-fixture.mjs";

const fixture = await startUIFixture();
try {
  for (const [name, engine, launch] of engines) {
    const browser = await engine.launch({ headless: true, ...launch });
    try {
      for (const mobile of [false, true]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile });
        const errors = [], writes = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/cloud/api/**", async route => {
          if (route.request().method() !== "GET") writes.push(route.request().url());
          await route.fulfill({ json: { fileIds: [], folderIds: [], folders: [], totalBytes: 0, totalFiles: 0 } });
        });
        await preparePage(page, fixture.origin, 4);
        await page.evaluate(() => {
          const state = __test.state;
          state.view = "trash"; state.itemRenderLimit = 50; state.listMode = true;
          const at = "2026-11-30T00:00:00.000Z";
          state.files = state.files.map((file, index) => ({ ...file, trashed: true, hasThumbnail: false,
            autoDeleteEligibleAt: index === 0 ? null : at,
            retentionMode: ["disabled", "dry-run", "enabled", "enabled"][index], purgeStarted: index === 3 }));
          state.folders = [{ id: 8, name: "ゴミ箱フォルダ", trashed: true, folderCount: 1, fileCount: 2,
            sizeBytes: 100, autoDeleteEligibleAt: at, retentionMode: "disabled" }];
          __test.renderItems();
        });
        const text = await page.locator("#content-grid").innerText();
        for (const label of ["自動削除の対象外", "試行中・自動削除なし", "次回定期処理から削除対象", "復元不可", "自動削除は無効"])
          assert.ok(text.includes(label), `${name} ${mobile}: ${label}`);
        const metadata = await page.locator(".file-meta").allTextContents();
        assert.ok(metadata.every(value => !value.includes("2026/9/12")), "trash shows retention rather than upload time");
        await page.locator(".trash-folder-card button").click();
        assert.equal(await page.locator("#trash-dialog").isVisible(), true);
        assert.equal(await page.locator("#restore-file-button").isEnabled(), true);
        await page.keyboard.press("Escape");
        await page.evaluate(() => { __test.state.folders[0].purgeStarted = true; __test.renderItems(); });
        await page.locator(".trash-folder-card button").click();
        assert.equal(await page.locator("#restore-file-button").isDisabled(), true);
        assert.match(await page.locator("#trash-action-note").innerText(), /復元できません/);
        await page.keyboard.press("Escape");
        assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        const directory = resolve(root, "tmp/trash-retention");
        mkdirSync(directory, { recursive: true });
        await page.screenshot({ path: resolve(directory, `${name}-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
        await page.close();
      }
    } finally { await browser.close(); }
    console.log(`PASS ${name}: trash eligibility/modes/legacy/irreversible labels, desktop/mobile, no writes`);
  }
} finally { await fixture.close(); }
