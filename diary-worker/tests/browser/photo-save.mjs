import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { chromium, webkit } from "playwright";
import { createDiaryFixtureServer } from "./bootstrap-fixture.mjs";

const publicRoot = new URL("../../public/", import.meta.url);
const raw = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0, 0xff, 0xd9]);
const photoId = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const photos = Array.from({ length: 12 }, (_, i) => ({ id: photoId(i + 1), fileName: i < 2 ? "original.jpg" : `original-${i + 1}.jpg`, contentType: "image/jpeg", originalSize: raw.length }));
let heldId = null, releaseOriginal, sessionName = "fixture", failId = null;
const originals = [], lists = [];
const json = (response, data, status = 200) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data));
};
const server = createDiaryFixtureServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost"), path = url.pathname.replace("/diary/api", "");
  if (url.pathname.startsWith("/diary/api/")) {
    if (path === "/session") return json(response, { authenticated: true, role: "admin", accountName: sessionName, loginId: `${sessionName}@example.test`, activeHouseholdId: "tanaka-household", householdId: "tanaka-household", canManageEntries: true });
    if (path === "/meta") return json(response, { months: [], tags: [], draftCount: 0 });
    if (path === "/entries") return json(response, { entries: [], hasMore: false });
    if (path === "/photos/meta") return json(response, { months: [{ value: "2026-11", count: 12 }] });
    if (path === "/photos") return json(response, { photos: [], hasMore: false });
    if (path === "/photos/save-list") { lists.push(Object.fromEntries(url.searchParams)); return json(response, { photos }); }
    const match = path.match(/^\/photos\/(.+)\/original$/);
    if (match) {
      const id = match[1]; originals.push(id);
      if (id === heldId) await new Promise(resolve => { releaseOriginal = resolve; });
      if (id === failId) return json(response, { error: "fixture expired" }, 401);
      response.writeHead(200, { "content-type": "image/jpeg", "content-length": raw.length, "content-disposition": `attachment; filename="original-${id.slice(-2)}.jpg"` });
      return response.end(raw);
    }
    return json(response, {});
  }
  const special = { "/assets/pwa-auto-update.js": new URL("../../assets/pwa-auto-update.js", publicRoot),
    "/security/passkey-client.js": new URL("../../security-worker/public/passkey-client.js", publicRoot) };
  const relative = url.pathname === "/diary/" ? "index.html" : url.pathname.replace(/^\/diary\//, "");
  const file = special[url.pathname] || new URL(relative, publicRoot);
  if (!special[url.pathname] && !file.href.startsWith(publicRoot.href)) return response.writeHead(404).end();
  try {
    const data = await readFile(file);
    response.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" })[extname(file.pathname)] || "application/octet-stream" }); response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const engine = process.env.TROOM_BROWSER === "webkit" ? webkit : chromium;
const executablePath = engine === chromium ? [process.env.TROOM_CHROMIUM_EXECUTABLE, chromium.executablePath(),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(p => p && existsSync(p)) : undefined;
const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.TROOM_CHROMIUM_CHANNEL ? { channel: process.env.TROOM_CHROMIUM_CHANNEL } : executablePath ? { executablePath } : {}) });
const contexts = [], errors = [];
const agents = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"
};
async function setup(method, profile = "windows") {
  const touch = ["android", "iphone", "iphoneChrome"].includes(profile);
  originals.length = 0; lists.length = 0; heldId = failId = null; sessionName = "fixture";
  const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, isMobile: touch, hasTouch: touch, userAgent: agents[profile], serviceWorkers: "block", acceptDownloads: true });
  contexts.push(context);
  await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(({ method }) => {
    window.__files = { "original.jpg": [88] }; window.__shares = []; window.__shareResult = "ok"; window.__pickerActivated = false; window.__pickerError = null; window.__shareSupported = true;
    const directory = { async getFileHandle(name, options) {
      if (!options?.create && !(name in window.__files)) throw new DOMException("missing", "NotFoundError");
      return { async createWritable() {
        const chunks = [];
        return new WritableStream({ write(chunk) { chunks.push(...chunk); }, close() { window.__files[name] = chunks; } });
      }, async getFile() { return new File([new Uint8Array(window.__files[name])], name); } };
    } };
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: method === "folder" ? () => { window.__pickerActivated = navigator.userActivation.isActive; return window.__pickerError ? Promise.reject(new DOMException("picker fixture", window.__pickerError)) : Promise.resolve(directory); } : undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: method === "share" ? () => window.__shareSupported : undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: method === "share" ? data => {
      const active = navigator.userActivation.isActive;
      return Promise.all(data.files.map(async file => ({ name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] }))).then(files => {
        window.__shares.push({ active, files });
        if (window.__shareResult === "cancel") throw new DOMException("cancel", "AbortError");
        if (window.__shareResult === "fail") throw new DOMException("blocked", "NotAllowedError");
      });
    } : undefined });
  }, { method });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/diary/`);
  await page.waitForSelector("#app-view:not([hidden])");
  await open(page);
  return page;
}
async function open(page) {
  await page.click("#camera-roll-button");
  await page.waitForFunction(() => document.getElementById("camera-roll-dialog").open);
  await page.waitForSelector('#photo-month-filter option[value="2026-11"]', { state: "attached" });
  await page.selectOption("#photo-month-filter", "2026-11");
  await page.click("#photo-save-button");
  await page.waitForFunction(() => document.getElementById("photo-save-dialog").open && !document.getElementById("photo-save-start").disabled);
}
const text = async (page, phrase) => page.waitForFunction(phrase => document.getElementById("photo-save-status").textContent.includes(phrase), phrase);
const stored = page => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith("troom-diary-photo-save-v1:"))?.[1] || "null"));
try {
  // Folder writes stay independent of both album dialogs and preserve raw bytes.
  const folder = await setup("folder");
  assert.equal(await folder.locator("#photo-save-button").textContent(), "まとめて保存");
  assert.equal(await folder.locator("#photo-file-name-search").count(), 0);
  assert.match(await folder.locator("#photo-entry-search").getAttribute("placeholder"), /画像ファイル名/);
  assert.equal(await folder.locator("#photo-save-method").count(), 0);
  assert.equal(await folder.locator("#photo-save-fallback").isVisible(), false);
  // Each field opens the existing wheel; cancelling never applies the draft.
  for (const field of ["from", "to"]) {
    const input = folder.locator(`#photo-save-${field}`);
    const previous = await input.inputValue();
    await input.click();
    await folder.waitForFunction(() => document.getElementById("date-wheel-dialog").open);
    await folder.locator('#date-wheel-day [data-value="15"]').click();
    await folder.click("#date-wheel-cancel");
    await folder.waitForFunction(() => !document.getElementById("date-wheel-dialog").open);
    assert.equal(await input.inputValue(), previous);
    await input.focus(); await folder.keyboard.press("Enter");
    await folder.waitForFunction(() => document.getElementById("date-wheel-dialog").open);
    await folder.locator('#date-wheel-day [data-value="15"]').click();
    await folder.keyboard.press("Escape");
    await folder.waitForFunction(() => !document.getElementById("date-wheel-dialog").open);
    assert.equal(await input.inputValue(), previous);
  }
  await folder.click("#photo-save-from");
  await folder.locator('#date-wheel-day [data-value="2"]').click();
  await folder.click("#date-wheel-done");
  await folder.waitForFunction(() => !document.getElementById("date-wheel-dialog").open);
  assert.equal(await folder.locator("#photo-save-from").inputValue(), "2026-11-02", "a tapped day is applied even when immediately confirmed");
  await folder.waitForFunction(() => !document.getElementById("photo-save-start").disabled);
  assert.equal(lists.at(-1).dateFrom, "2026-11-02");
  await folder.click('[data-date-picker-target="photo-save-from"]');
  await folder.waitForFunction(() => document.getElementById("troom-calendar-dialog").open);
  await folder.keyboard.press("Escape");
  await folder.waitForFunction(() => !document.getElementById("troom-calendar-dialog").open && document.getElementById("photo-save-dialog").open);
  assert.deepEqual(lists[0], { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
  await folder.click('[data-date-picker-target="photo-save-from"]');
  await folder.click('[data-calendar-value="2026-11-02"]');
  await folder.waitForFunction(() => document.getElementById("photo-save-from").value === "2026-11-02" && !document.getElementById("photo-save-start").disabled);
  assert.equal(lists.at(-1).dateFrom, "2026-11-02", "shared calendar selection refreshes the save range");
  await folder.evaluate(() => history.back());
  await folder.waitForFunction(() => !document.getElementById("photo-save-dialog").open && document.getElementById("camera-roll-dialog").open);
  await folder.click("#photo-save-button");
  await folder.waitForFunction(() => !document.getElementById("photo-save-start").disabled);
  heldId = photoId(2);
  await folder.click("#photo-save-start");
  await text(folder, "1 / 12枚");
  await folder.click('[data-close-dialog="photo-save-dialog"]');
  await folder.waitForFunction(() => !document.getElementById("photo-save-dialog").open);
  await folder.keyboard.press("Escape");
  await folder.waitForFunction(() => !document.getElementById("camera-roll-dialog").open);
  assert.equal(await folder.evaluate(() => document.dispatchEvent(new Event("troom:before-auto-update", { cancelable: true }))), false);
  releaseOriginal(); heldId = null;
  await text(folder, "保存が完了");
  const output = await folder.evaluate(() => window.__files);
  assert.deepEqual(output["original.jpg"], [88], "existing file is untouched");
  assert.equal(Object.keys(output).length, 13);
  for (const [name, bytes] of Object.entries(output)) if (name !== "original.jpg") assert.deepEqual(bytes, [...raw], "no resize, ZIP or EXIF conversion");
  assert.equal(await folder.evaluate(() => window.__pickerActivated), true);
  assert.equal((await stored(folder)).done.length, 12);
  assert.equal(await folder.evaluate(() => document.dispatchEvent(new Event("troom:before-auto-update", { cancelable: true }))), true);
  await folder.context().close();

  // Reload keeps only acknowledged IDs; previously completed originals are skipped.
  const resume = await setup("folder"); heldId = photoId(2);
  await resume.click("#photo-save-start"); await text(resume, "1 / 12枚");
  await resume.click("#photo-save-pause"); releaseOriginal(); heldId = null;
  const checkpoint = await stored(resume);
  assert.equal(checkpoint.done.length, 1);
  assert.deepEqual(Object.keys(checkpoint).sort(), ["version", "from", "to", "ids", "done", "updatedAt"].sort());
  await resume.reload(); await open(resume); await text(resume, "1 / 12枚");
  await resume.click("#photo-save-start"); await text(resume, "保存が完了");
  assert.equal(originals.filter(id => id === photoId(1)).length, 1);
  sessionName = "another-account";
  await resume.reload(); await open(resume);
  assert.match(await resume.locator("#photo-save-start").textContent(), /保存を開始/);
  assert.doesNotMatch(await resume.locator("#photo-save-status").textContent(), /12 \/ 12/);
  await resume.context().close();

  // A revoked session stops the queue and retains only resumable metadata.
  const expired = await setup("folder"); failId = photoId(1);
  await expired.click("#photo-save-start");
  await expired.waitForSelector("#login-view:not([hidden])");
  assert.equal(originals.length, 1);
  assert.equal((await stored(expired)).done.length, 0);
  assert.equal(await expired.locator("#photo-save-dialog").evaluate(dialog => dialog.open), false);
  failId = null;
  await expired.reload(); await open(expired);
  await expired.click("#photo-save-start"); await text(expired, "保存が完了");
  await expired.context().close();

  // iPhone Safari and iPhone Chrome both hand off exactly one original per tap.
  for (const profile of ["iphone", "iphoneChrome"]) {
    const share = await setup("share", profile);
    await share.click("#photo-save-start"); await text(share, "元画像を1枚準備");
    assert.equal(await share.evaluate(() => window.__shares.length), 0);
    await share.evaluate(() => { window.__shareResult = "cancel"; });
    await share.click("#photo-save-start"); await text(share, "保存画面を閉じました");
    assert.equal((await stored(share)).done.length, 0);
    assert.equal(await share.locator("#photo-save-fallback").isVisible(), false, "cancellation does not switch methods");
    await share.evaluate(() => { window.__shareResult = "ok"; });
    await share.click("#photo-save-start"); await text(share, "実際に保存できたこと");
    assert.equal((await stored(share)).done.length, 0, "share resolution is not a saved-file receipt");
    const shares = await share.evaluate(() => window.__shares);
    assert.ok(shares.every(call => call.active && call.files.length === 1));
    assert.deepEqual(shares[1].files[0].bytes, [...raw]);
    await share.click("#photo-save-start"); await text(share, "元画像を1枚準備");
    assert.equal((await stored(share)).done.length, 1);
    assert.ok(await share.locator("#photo-save-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
    // Failure offers the alternate method, preserving acknowledged progress.
    await share.evaluate(() => { window.__shareResult = "fail"; });
    await share.click("#photo-save-start"); await text(share, "保存画面を開けませんでした");
    assert.equal(await share.locator("#photo-save-fallback").isVisible(), true);
    await share.click("#photo-save-fallback");
    await share.click("#photo-save-start"); await text(share, "元画像を1枚準備");
    const download = share.waitForEvent("download");
    await share.click("#photo-save-start");
    assert.deepEqual(await readFile(await (await download).path()), raw);
    assert.equal((await stored(share)).done.length, 1);
    await share.context().close();
  }

  // Android ignores a present folder API. Desktop Safari and iPhone without
  // file sharing use the same single-file download flow with real downloads.
  for (const [method, profile] of [["folder", "android"], ["browser", "safari"], ["browser", "iphone"]]) {
    const fallback = await setup(method, profile); const downloads = [];
    fallback.on("download", download => downloads.push(download));
    assert.equal(await fallback.locator("#photo-save-fallback").isVisible(), false);
    await fallback.click("#photo-save-start"); await text(fallback, "元画像を1枚準備");
    assert.equal(downloads.length, 0, "preparation does not attempt an unactivated download");
    assert.equal(await fallback.evaluate(() => window.__pickerActivated), false);
    for (let i = 0; i < photos.length; i++) {
      const downloaded = fallback.waitForEvent("download");
      await fallback.click("#photo-save-start");
      const download = await downloaded;
      assert.deepEqual(await readFile(await download.path()), raw);
      assert.equal(download.suggestedFilename(), i === 0 ? "original.jpg" : i === 1 ? "original (2).jpg" : `original-${i + 1}.jpg`);
      assert.equal((await stored(fallback)).done.length, i);
      await fallback.click("#photo-save-start");
      await text(fallback, i === photos.length - 1 ? "全画像の保存確認が完了" : "元画像を1枚準備");
    }
    assert.equal(downloads.length, 12);
    assert.equal((await stored(fallback)).done.length, 12);
    await fallback.context().close();
  }

  // A per-image sharing rejection keeps the photo pending and offers a download.
  const unsupported = await setup("share", "iphone");
  await unsupported.evaluate(() => { window.__shareSupported = false; });
  await unsupported.click("#photo-save-start"); await text(unsupported, "この写真は端末の保存画面へ渡せません");
  assert.equal((await stored(unsupported)).done.length, 0);
  await unsupported.click("#photo-save-fallback");
  await unsupported.click("#photo-save-start"); await text(unsupported, "元画像を1枚準備");
  await unsupported.context().close();

  // Individual downloads must also stop at a revoked session before handoff.
  const mobileExpired = await setup("browser", "android"); failId = photoId(1);
  await mobileExpired.click("#photo-save-start");
  await mobileExpired.waitForSelector("#login-view:not([hidden])");
  assert.equal((await stored(mobileExpired)).done.length, 0);
  assert.equal(originals.length, 1);
  await mobileExpired.context().close();

  // A folder permission failure offers individual downloads; cancel does not.
  const denied = await setup("folder");
  await denied.evaluate(() => { window.__pickerError = "AbortError"; });
  await denied.click("#photo-save-start"); await text(denied, "保存先の選択を閉じました");
  assert.equal(await denied.locator("#photo-save-fallback").isVisible(), false);
  await denied.evaluate(() => { window.__pickerError = "NotAllowedError"; });
  await denied.click("#photo-save-start"); await text(denied, "フォルダに保存できませんでした");
  await denied.click("#photo-save-fallback");
  await denied.click("#photo-save-start"); await text(denied, "元画像を1枚準備");
  await denied.context().close();
  assert.deepEqual(errors, []);
  console.log(`Album save browser (${engine.name()}): Windows folder writes, Android/iPhone/Safari profiles, date field wheels/calendar, close/back, update guard, resume, account isolation, cancel/acknowledgement, error fallback and individual original downloads passed.`);
} finally {
  releaseOriginal?.();
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
