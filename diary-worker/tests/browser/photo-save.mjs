import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
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
const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const contexts = [], errors = [];
async function setup(method, touch = false) {
  originals.length = 0; lists.length = 0; heldId = failId = null; sessionName = "fixture";
  const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, isMobile: touch, hasTouch: touch, serviceWorkers: "block", acceptDownloads: true });
  contexts.push(context);
  await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(({ method }) => {
    window.__files = { "original.jpg": [88] }; window.__shares = []; window.__shareResult = "ok"; window.__pickerActivated = false;
    const directory = { async getFileHandle(name, options) {
      if (!options?.create && !(name in window.__files)) throw new DOMException("missing", "NotFoundError");
      return { async createWritable() {
        const chunks = [];
        return new WritableStream({ write(chunk) { chunks.push(...chunk); }, close() { window.__files[name] = chunks; } });
      }, async getFile() { return new File([new Uint8Array(window.__files[name])], name); } };
    } };
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: method === "folder" ? () => { window.__pickerActivated = navigator.userActivation.isActive; return Promise.resolve(directory); } : undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: method === "share" ? () => true : undefined });
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

  // File sharing uses a fresh click after preparation and requires save acknowledgement.
  const share = await setup("share", true);
  assert.equal(await share.locator("#photo-save-method").inputValue(), "share");
  await share.click("#photo-save-start"); await text(share, "10枚の元画像を準備");
  assert.equal(await share.evaluate(() => window.__shares.length), 0, "preparation never opens share without a click");
  await share.evaluate(() => { window.__shareResult = "cancel"; });
  await share.click("#photo-save-start"); await text(share, "保存画面を閉じました");
  assert.equal((await stored(share)).done.length, 0);
  await share.evaluate(() => { window.__shareResult = "ok"; });
  await share.click("#photo-save-start"); await text(share, "実際に保存できたこと");
  assert.equal((await stored(share)).done.length, 0, "share resolution is not a saved-file receipt");
  const shares = await share.evaluate(() => window.__shares);
  assert.ok(shares.every(call => call.active));
  assert.equal(new Set(shares[1].files.map(file => file.name)).size, 10);
  assert.ok(shares[1].files.every(file => JSON.stringify(file.bytes) === JSON.stringify([...raw])));
  await share.click("#photo-save-start"); await text(share, "2枚の元画像を準備");
  assert.equal((await stored(share)).done.length, 10);
  assert.ok(await share.locator("#photo-save-dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), "mobile dialog does not overflow");
  if (process.env.PHOTO_SAVE_SCREENSHOTS) {
    await mkdir(process.env.PHOTO_SAVE_SCREENSHOTS, { recursive: true });
    await share.screenshot({ path: `${process.env.PHOTO_SAVE_SCREENSHOTS}/photo-save-mobile.png` });
  }
  await share.click("#photo-save-start"); await text(share, "実際に保存できたこと");
  await share.click("#photo-save-start"); await text(share, "全画像の保存確認が完了");
  await share.context().close();

  // The universal fallback delegates separate original files, never an archive.
  const fallback = await setup("browser"); const downloads = [];
  fallback.on("download", download => downloads.push(download));
  assert.equal(await fallback.locator("#photo-save-method").inputValue(), "browser");
  await fallback.click("#photo-save-start"); await text(fallback, "10枚をブラウザへ渡しました");
  assert.equal(downloads.length, 10);
  assert.equal((await stored(fallback)).done.length, 0);
  assert.deepEqual(await readFile(await downloads[0].path()), raw);
  await fallback.click("#photo-save-start"); await text(fallback, "2枚をブラウザへ渡しました");
  await fallback.click("#photo-save-start"); await text(fallback, "全画像の保存確認が完了");
  assert.equal(downloads.length, 12);
  await fallback.context().close();
  assert.deepEqual(errors, []);
  console.log(`Album save browser (${engine.name()}): folder writes, close/back, shared calendar, update guard, resume, account isolation, sharing/cancel/acknowledgement and individual downloads passed.`);
} finally {
  releaseOriginal?.();
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
