import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, firefox } = require("playwright");
const publicRoot = resolve(fileURLToPath(new URL("../../public/", import.meta.url)));
const workspace = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const updaterPath = resolve(workspace, "assets/pwa-auto-update.js");
const passkeyClientPath = resolve(workspace, "security-worker/public/passkey-client.js");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};
const entries = Array.from({ length: 60 }, (_, index) => ({
  id: index + 1,
  entryDate: `2026-08-${String(28 - (index % 27)).padStart(2, "0")}`,
  title: `復元確認の日記 ${index + 1}`,
  content: `戻る位置の動的確認 ${index + 1}`,
  authorName: "テスト",
  tags: [`タグ${String(index + 1).padStart(3, "0")}`],
  status: "published",
  deletedAt: null,
  isFavorite: index < 25,
  revision: 1,
  photos: []
}));
const tags = Array.from({ length: 90 }, (_, index) => ({
  value: `タグ${String(index + 1).padStart(3, "0")}`,
  count: 100 - index
}));

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (apiPath === "/session") return sendJson(response, {
      authenticated: true,
      role: "admin",
      accountName: "復元テスト",
      householdId: "main-household",
      activeHouseholdId: "main-household",
      isGlobalOwner: false,
      canManageEntries: true,
      canViewTrash: true,
      canPermanentlyDelete: true,
      canViewInvestment: false
    });
    if (apiPath === "/meta") return sendJson(response, {
      draftCount: 0,
      months: [{ value: "2026-08", count: entries.length }],
      tags
    });
    if (apiPath === "/entries") {
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 20);
      const source = url.searchParams.get("favorite") === "1" ? entries.filter((entry) => entry.isFavorite) : entries;
      return sendJson(response, {
        entries: source.slice(offset, offset + limit),
        hasMore: offset + limit < source.length
      });
    }
    const detail = apiPath.match(/^\/entries\/(\d+)$/);
    if (detail) return sendJson(response, { entry: entries[Number(detail[1]) - 1] });
    return sendJson(response, {});
  }
  if (url.pathname === "/assets/pwa-auto-update.js") return sendFile(response, updaterPath);
  if (url.pathname === "/security/passkey-client.js") return sendFile(response, passkeyClientPath);

  const isDiaryRoute = /^\/diary\/(?:|tags\/?|favorites\/?|tag\/[^/]+\/?)$/.test(url.pathname);
  const relativePath = isDiaryRoute ? "index.html" : url.pathname.replace(/^\/diary\//, "");
  const target = resolve(publicRoot, relativePath);
  if (!target.startsWith(`${publicRoot}${sep}`) && target !== publicRoot) return response.writeHead(404).end();
  try {
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    return sendFile(response, target);
  } catch {
    return response.writeHead(404).end();
  }
});

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(await readFile(path));
}

function browserExecutable(name) {
  const configured = process.env[`TROOM_${name.toUpperCase()}_EXECUTABLE`];
  if (configured) return configured;
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
  const firefoxCandidates = name === "firefox" && playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory() && candidate.name.startsWith("firefox-"))
        .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
        .map((candidate) => join(playwrightRoot, candidate.name, "firefox", "firefox.exe"))
    : [];
  const candidates = name === "firefox"
    ? [...firefoxCandidates, "C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"]
    : ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

async function waitForDiary(page) {
  await page.waitForSelector("#app-view:not([hidden])");
  await page.waitForFunction(() => document.querySelectorAll("#tag-list [data-tag]").length >= 80);
}

async function setTagContext(page, fraction) {
  await page.fill("#tag-search-input", "タグ");
  return page.locator("#tag-list").evaluate((container, targetFraction) => {
    container.scrollTop = (container.scrollHeight - container.clientHeight) * targetFraction;
    const containerRect = container.getBoundingClientRect();
    const anchor = [...container.querySelectorAll("[data-tag]")].find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
    });
    const rect = anchor.getBoundingClientRect();
    return {
      tag: anchor.dataset.tag,
      scrollTop: container.scrollTop,
      top: rect.top - containerRect.top
    };
  }, fraction);
}

async function assertTagContext(page, expected, label) {
  await page.waitForFunction(() => document.querySelector("#tag-search-input")?.value === "タグ");
  await page.waitForTimeout(650);
  const actual = await page.locator("#tag-list").evaluate((container, tag) => {
    const anchor = [...container.querySelectorAll("[data-tag]")].find((item) => item.dataset.tag === tag);
    return {
      scrollTop: container.scrollTop,
      top: anchor.getBoundingClientRect().top - container.getBoundingClientRect().top
    };
  }, expected.tag);
  assert.ok(Math.abs(actual.scrollTop - expected.scrollTop) <= 3, `${label}: タグ一覧scrollTopを復元 expected=${expected.scrollTop} actual=${actual.scrollTop}`);
  assert.ok(Math.abs(actual.top - expected.top) <= 3, `${label}: タグanchor相対位置を復元 expected=${expected.top} actual=${actual.top}`);
}

async function storedTagContext(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("troom-diary-return-view-v1")).tagListPosition);
}

async function run(browserType, name, executablePath) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
    await waitForDiary(page);

    const browserBackContext = await setTagContext(page, 0.62);
    await Promise.all([
      page.waitForURL(new RegExp(`/diary/tag/${encodeURIComponent(browserBackContext.tag)}/?$`)),
      page.locator(`#tag-list [data-tag="${browserBackContext.tag}"]`).click()
    ]);
    const browserBackStoredContext = await storedTagContext(page);
    await page.goBack({ waitUntil: "networkidle" });
    await waitForDiary(page);
    await assertTagContext(page, browserBackStoredContext, `${name} browser Back`);
    await page.reload({ waitUntil: "networkidle" });
    await waitForDiary(page);
    await assertTagContext(page, browserBackStoredContext, `${name} reload後`);

    const appBackContext = await setTagContext(page, 0.35);
    await Promise.all([
      page.waitForURL(new RegExp(`/diary/tag/${encodeURIComponent(appBackContext.tag)}/?$`)),
      page.locator(`#tag-list [data-tag="${appBackContext.tag}"]`).click()
    ]);
    const appBackStoredContext = await storedTagContext(page);
    assert.equal(await page.locator("#tag-page-back").textContent(), "← 前の画面へ戻る", `${name}: 遷移元を示す戻る導線`);
    await page.locator("#tag-page-back").click();
    await page.waitForURL(/\/diary\/?$/);
    await waitForDiary(page);
    await assertTagContext(page, appBackStoredContext, `${name} app Back`);

    await page.goto(`${origin}/diary/tags/`, { waitUntil: "networkidle" });
    await waitForDiary(page);
    await page.fill("#tag-search-input", "タグ0");
    await page.locator('#tag-list [data-tag="タグ065"]').scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForURL(new RegExp(`/diary/tag/${encodeURIComponent("タグ065")}/?$`)),
      page.locator('#tag-list [data-tag="タグ065"]').click()
    ]);
    const directoryReturn = await page.evaluate(() => JSON.parse(sessionStorage.getItem("troom-diary-return-view-v1")));
    assert.equal(await page.locator("#tag-page-back").getAttribute("href"), "/diary/tags/", `${name}: タグ詳細の戻り先`);
    await page.locator("#tag-page-back").click();
    await page.waitForURL(/\/diary\/tags\/?$/);
    await waitForDiary(page);
    await page.waitForTimeout(650);
    assert.equal(await page.locator("#tag-search-input").inputValue(), "タグ0", `${name}: タグ一覧の検索語を復元`);
    const directoryScrollY = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(directoryScrollY - directoryReturn.position.scrollY) <= 3, `${name}: タグ一覧ページのscrollYを復元`);

    await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
    await waitForDiary(page);
    await page.fill("#diary-search-input", "復元確認");
    await page.waitForTimeout(400);
    await page.waitForSelector('#entry-list [data-entry-id="20"]');
    await page.click("#load-more-button");
    await page.waitForSelector('#entry-list [data-entry-id="40"]');
    await page.locator('#entry-list [data-entry-id="32"]').evaluate((entry) => {
      entry.scrollIntoView({ block: "center" });
    });
    await Promise.all([
      page.waitForURL(/\/diary\/favorites\/?$/),
      page.evaluate(() => document.querySelector("#favorites-link").click())
    ]);
    const entryPosition = await page.evaluate(() => JSON.parse(sessionStorage.getItem("troom-diary-return-view-v1")).position);
    await page.goBack({ waitUntil: "networkidle" });
    await page.waitForSelector('#entry-list [data-entry-id="40"]');
    await page.waitForTimeout(650);
    assert.equal(await page.locator("#diary-search-input").inputValue(), "復元確認", `${name}: 検索語を復元`);
    const restored = await page.locator(`[data-entry-id="${entryPosition.entryId}"]`).evaluate((entry) => ({
      top: entry.getBoundingClientRect().top,
      scrollY: window.scrollY,
      maxScroll: document.documentElement.scrollHeight - window.innerHeight
    }));
    assert.ok(Math.abs(restored.top - entryPosition.top) <= 3, `${name}: entry IDと相対位置を復元 expected=${JSON.stringify(entryPosition)} actual=${JSON.stringify(restored)}`);
    assert.deepEqual(pageErrors, [], `${name}: page errorなし`);
    await context.close();
  } finally {
    await browser.close();
  }
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await run(chromium, "Chromium", chromiumPath);
  await run(firefox, "Firefox", firefoxPath);
  process.stdout.write("Diary return position and view-state restoration passed in Chromium and Firefox.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
