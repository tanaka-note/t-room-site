import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname } from "node:path";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_PACKAGE || (process.env.TROOM_BROWSER === "webkit" ? "playwright-webkit" : "playwright"));
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
  await context.addInitScript(({ method, folderApiAvailable }) => {
    // Synthetic filesystem contents survive reload, just as real disk files do.
    window.__files = JSON.parse(sessionStorage.getItem("fixture-files") || '{"original.jpg":[88]}');
    window.__directories = JSON.parse(sessionStorage.getItem("fixture-directories") || '[""]');
    window.__directoryCalls = []; window.__pickedFolder = ""; window.__directoryError = null; window.__pickerCalls = 0;
    window.__shares = []; window.__shareResult = "ok"; window.__pickerActivated = false; window.__pickerError = null; window.__shareSupported = true;
    window.__persistFileSystem = () => {
      sessionStorage.setItem("fixture-files", JSON.stringify(window.__files));
      sessionStorage.setItem("fixture-directories", JSON.stringify(window.__directories));
    };
    function directoryAt(path) {
      const child = name => path ? `${path}/${name}` : name;
      return {
        async getDirectoryHandle(name, options) {
          window.__directoryCalls.push({ path, name, create: Boolean(options?.create) });
          const target = child(name);
          if (target in window.__files) throw new DOMException("file", "TypeMismatchError");
          if (!window.__directories.includes(target)) {
            if (!options?.create) throw new DOMException("missing", "NotFoundError");
            if (window.__directoryError) throw new DOMException("denied", window.__directoryError);
            window.__directories.push(target); window.__persistFileSystem();
          }
          return directoryAt(target);
        },
        async getFileHandle(name, options) {
          const target = child(name);
          if (window.__directories.includes(target)) throw new DOMException("directory", "TypeMismatchError");
          if (!options?.create && !(target in window.__files)) throw new DOMException("missing", "NotFoundError");
          return { async createWritable() {
            const chunks = [];
            return new WritableStream({ write(chunk) { chunks.push(...chunk); }, close() { window.__files[target] = chunks; window.__persistFileSystem(); } });
          }, async getFile() { return new File([new Uint8Array(window.__files[target])], name); } };
        }
      };
    }
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: folderApiAvailable ? () => { window.__pickerCalls++; window.__pickerActivated = navigator.userActivation.isActive; return window.__pickerError ? Promise.reject(new DOMException("picker fixture", window.__pickerError)) : Promise.resolve(directoryAt(window.__pickedFolder)); } : undefined });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: method === "share" ? () => window.__shareSupported : undefined });
    Object.defineProperty(navigator, "share", { configurable: true, value: method === "share" ? data => {
      const active = navigator.userActivation.isActive;
      return Promise.all(data.files.map(async file => ({ name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer())] }))).then(files => {
        window.__shares.push({ active, files });
        if (window.__shareResult === "cancel") throw new DOMException("cancel", "AbortError");
        if (window.__shareResult === "fail") throw new DOMException("blocked", "NotAllowedError");
      });
    } : undefined });
  }, { method, folderApiAvailable: method === "folder" || touch });
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
const text = async (page, phrase) => {
  try { await page.waitForFunction(phrase => document.getElementById("photo-save-status").textContent.includes(phrase), phrase); }
  catch (error) { error.message += `\nExpected: ${phrase}\nActual: ${await page.locator("#photo-save-status").textContent()}`; throw error; }
};
const stored = page => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([key]) => key.startsWith("troom-diary-photo-save-v1:"))?.[1] || "null"));
async function logout(page) {
  await page.click('[data-close-dialog="photo-save-dialog"]');
  await page.waitForFunction(() => !document.getElementById("photo-save-dialog").open);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("camera-roll-dialog").open);
  await page.click("#logout-button");
  await page.waitForSelector("#login-view:not([hidden])");
}

try {
  // Both engines verify date inputs and modal history; only Chromium exercises
  // the folder API that desktop Safari does not provide.
  const folder = await setup(engine === chromium ? "folder" : "browser", engine === chromium ? "windows" : "safari");
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
  await folder.click("#troom-calendar-title");
  await folder.click('[data-calendar-value="2026"]');
  await folder.click('[data-calendar-value="2026-11"]');
  await folder.click('[data-calendar-value="2026-11-02"]');
  await folder.waitForFunction(() => document.getElementById("photo-save-from").value === "2026-11-02" && !document.getElementById("photo-save-start").disabled);
  assert.equal(lists.at(-1).dateFrom, "2026-11-02", "shared calendar selection refreshes the save range");
  await folder.evaluate(() => history.back());
  await folder.waitForFunction(() => !document.getElementById("photo-save-dialog").open && document.getElementById("camera-roll-dialog").open);
  await folder.click("#photo-save-button");
  await folder.waitForFunction(() => !document.getElementById("photo-save-start").disabled);
  if (engine === chromium) {
    const periodFolder = "写真_2026-11-02～2026-11-30";
    await folder.evaluate(name => {
      window.__directories.push(name);
      window.__files[`${name}/keep.jpg`] = [77];
      window.__files[`${name} (2)`] = [66];
      window.__persistFileSystem();
    }, periodFolder);
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
    assert.deepEqual(output[`${periodFolder}/keep.jpg`], [77]);
    assert.deepEqual(output[`${periodFolder} (2)`], [66]);
    const exportName = `${periodFolder} (3)`;
    const exported = Object.entries(output).filter(([name]) => name.startsWith(exportName + "/"));
    assert.equal(Object.keys(output).length, 15);
    assert.equal(exported.length, 12, "all originals are written inside one new dated folder");
    for (const [, bytes] of exported) assert.deepEqual(bytes, [...raw], "no resize, ZIP or EXIF conversion");
    assert.deepEqual(await folder.evaluate(() => window.__directories), ["", periodFolder, exportName]);
    assert.equal((await stored(folder)).folderName, exportName);
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
    assert.deepEqual(Object.keys(checkpoint).sort(), ["version", "from", "to", "ids", "done", "updatedAt", "folderName"].sort());
    assert.equal(checkpoint.folderName, "写真_2026-11-01～2026-11-30");
    await resume.evaluate(() => { window.__pickedFolder = "other-parent"; });
    await resume.click("#photo-save-start"); await text(resume, "前回の写真フォルダが見つかりません");
    assert.equal((await stored(resume)).done.length, 1);
    assert.equal(await resume.evaluate(() => window.__directoryCalls.filter(call => call.path === "other-parent" && call.create).length), 0);
    await resume.reload(); await open(resume); await text(resume, "1 / 12枚");
    await resume.click("#photo-save-start"); await text(resume, "保存が完了");
    assert.equal(originals.filter(id => id === photoId(1)).length, 1);
    assert.equal(await resume.evaluate(() => window.__directoryCalls.filter(call => call.create).length), 0, "resume reuses the generated folder without creating another");
    assert.equal(await resume.evaluate(name => Object.keys(window.__files).filter(path => path.startsWith(name + "/")).length, checkpoint.folderName), 12);
    await logout(resume);
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

    // A one-day export has a single date in its folder name.
    const day = await setup("folder");
    await day.click("#photo-save-to");
    await day.locator('#date-wheel-day [data-value="1"]').click();
    await day.click("#date-wheel-done");
    await day.waitForFunction(() => !document.getElementById("photo-save-start").disabled);
    await day.click("#photo-save-start"); await text(day, "保存が完了");
    assert.equal((await stored(day)).folderName, "写真_2026-11-01");
    assert.equal(await day.evaluate(() => Object.keys(window.__files).filter(path => path.startsWith("写真_2026-11-01/")).length), 12);
    await day.context().close();

    // Use actual browser filesystem handles as well as the permission fixtures.
    const filesystem = await setup("folder");
    await filesystem.evaluate(() => Object.defineProperty(window, "showDirectoryPicker", {
      value: () => navigator.storage.getDirectory(), configurable: true
    }));
    await filesystem.click("#photo-save-start"); await text(filesystem, "保存が完了");
    const actualFiles = await filesystem.evaluate(async () => {
      const parent = await navigator.storage.getDirectory();
      const folders = []; for await (const [name] of parent.entries()) folders.push(name);
      const target = await parent.getDirectoryHandle("写真_2026-11-01～2026-11-30");
      const files = [];
      for await (const [name, handle] of target.entries()) files.push({ name, bytes: [...new Uint8Array(await (await handle.getFile()).arrayBuffer())] });
      return { folders, files };
    });
    assert.deepEqual(actualFiles.folders, ["写真_2026-11-01～2026-11-30"]);
    assert.equal(actualFiles.files.length, 12);
    assert.ok(actualFiles.files.every(file => JSON.stringify(file.bytes) === JSON.stringify([...raw])));
    await filesystem.context().close();

    // Older checkpoints retain their direct-to-folder layout on resume.
    const legacy = await setup("folder"); heldId = photoId(2);
    await legacy.click("#photo-save-start"); await text(legacy, "1 / 12枚");
    await legacy.click("#photo-save-pause"); releaseOriginal(); heldId = null;
    await legacy.evaluate(raw => {
      const key = Object.keys(localStorage).find(key => key.startsWith("troom-diary-photo-save-v1:"));
      const previous = JSON.parse(localStorage.getItem(key)); delete previous.folderName;
      localStorage.setItem(key, JSON.stringify(previous));
      window.__files = { "original.jpg": raw }; window.__directories = [""]; window.__persistFileSystem();
    }, [...raw]);
    await legacy.context().addInitScript(() => {
      // Simulate an old checkpoint after the current page's pagehide persistence.
      for (const key of Object.keys(localStorage).filter(key => key.startsWith("troom-diary-photo-save-v1:"))) {
        const previous = JSON.parse(localStorage.getItem(key)); delete previous.folderName;
        localStorage.setItem(key, JSON.stringify(previous));
      }
    });
    await legacy.reload(); await open(legacy);
    await legacy.click("#photo-save-start"); await text(legacy, "保存が完了");
    assert.equal(await legacy.evaluate(() => window.__directoryCalls.length), 0);
    assert.equal(await legacy.evaluate(() => Object.keys(window.__files).length), 12);
    assert.equal(Object.hasOwn(await stored(legacy), "folderName"), false);
    await legacy.context().close();
  } else {
    await folder.context().close();
  }

  // iPhone Safari and iPhone Chrome both hand off exactly one original per tap.
  for (const profile of ["iphone", "iphoneChrome"]) {
    const share = await setup("share", profile);
    // Touch input uses the same wheel and preserves cancellation semantics.
    await share.locator("#photo-save-to").tap();
    await share.locator('#date-wheel-day [data-value="29"]').tap();
    await share.locator("#date-wheel-done").tap();
    await share.waitForFunction(() => !document.getElementById("date-wheel-dialog").open);
    assert.equal(await share.locator("#photo-save-to").inputValue(), "2026-11-29");
    await share.locator("#photo-save-to").tap();
    await share.locator('#date-wheel-day [data-value="15"]').tap();
    await share.locator("#date-wheel-cancel").tap();
    await share.waitForFunction(() => !document.getElementById("date-wheel-dialog").open);
    assert.equal(await share.locator("#photo-save-to").inputValue(), "2026-11-29");
    await share.waitForFunction(() => !document.getElementById("photo-save-start").disabled);
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
    assert.equal(Object.hasOwn(await stored(share), "folderName"), false);
    assert.equal(await share.evaluate(() => window.__pickerCalls + window.__directoryCalls.length), 0, "iPhone never selects or creates a folder even if the API exists");
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
    // Reload retries an unacknowledged image, never the previously saved one.
    await share.reload(); await open(share);
    await share.click("#photo-save-start"); await text(share, "元画像を1枚準備");
    assert.equal((await stored(share)).done.length, 1);
    await share.click("#photo-save-start"); await text(share, "実際に保存できたこと");
    assert.equal((await share.evaluate(() => window.__shares))[0].files[0].name, "original (2).jpg");
    await logout(share);
    sessionName = "another-account";
    await share.reload(); await open(share);
    assert.match(await share.locator("#photo-save-start").textContent(), /保存を開始/);
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
      const expectedName = i === 0 ? "original.jpg" : i === 1 ? "original (2).jpg" : `original-${i + 1}.jpg`;
      assert.ok([expectedName, expectedName.replaceAll(" ", "_")].includes(download.suggestedFilename()), "browser/OS filename sanitization preserves the image name and extension");
      assert.equal((await stored(fallback)).done.length, i);
      await fallback.click("#photo-save-start");
      await text(fallback, i === photos.length - 1 ? "全画像の保存確認が完了" : "元画像を1枚準備");
    }
    assert.equal(downloads.length, 12);
    assert.equal(new Set(downloads.map(download => download.suggestedFilename())).size, 12, "same-name originals remain distinct");
    assert.equal((await stored(fallback)).done.length, 12);
    assert.equal(Object.hasOwn(await stored(fallback), "folderName"), false);
    assert.equal(await fallback.evaluate(() => window.__pickerCalls + window.__directoryCalls.length), 0, "individual downloads never enter folder handling");
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
  if (engine === chromium) {
    const creationDenied = await setup("folder");
    await creationDenied.evaluate(() => { window.__directoryError = "NotAllowedError"; });
    await creationDenied.click("#photo-save-start"); await text(creationDenied, "フォルダに保存できませんでした");
    assert.equal(await stored(creationDenied), null);
    assert.equal(originals.length, 0, "a failed folder creation never starts downloading images");
    assert.deepEqual(await creationDenied.evaluate(() => window.__directories), [""]);
    await creationDenied.context().close();
    const denied = await setup("folder");
    await denied.evaluate(() => { window.__pickerError = "AbortError"; });
    await denied.click("#photo-save-start"); await text(denied, "保存先の選択を閉じました");
    assert.equal(await denied.locator("#photo-save-fallback").isVisible(), false);
    await denied.evaluate(() => { window.__pickerError = "NotAllowedError"; });
    await denied.click("#photo-save-start"); await text(denied, "フォルダに保存できませんでした");
    await denied.click("#photo-save-fallback");
    await denied.click("#photo-save-start"); await text(denied, "元画像を1枚準備");
    await denied.context().close();
  }
  assert.deepEqual(errors, []);
  console.log(`Album save browser (${engine.name()}): ${engine === chromium ? "Windows folder writes, " : ""}Android/iPhone/Safari profiles, date field wheels/calendar, close/back, update guard, resume, account isolation, cancel/acknowledgement, error fallback and individual original downloads passed.`);
} finally {
  releaseOriginal?.();
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
