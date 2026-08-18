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
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};
const entry = {
  id: 1,
  entryDate: "2026-08-18",
  title: "お気に入りテスト",
  content: "お気に入りの本文",
  authorName: "テスト",
  tags: [],
  status: "published",
  deletedAt: null,
  isFavorite: false,
  revision: 1,
  photos: []
};
let isFavorite = false;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (apiPath === "/session") return sendJson(response, {
      authenticated: true,
      role: "admin",
      accountName: "テスト",
      householdId: "main-household",
      activeHouseholdId: "main-household",
      isGlobalOwner: false,
      canManageEntries: true,
      canViewTrash: true,
      canPermanentlyDelete: true,
      canViewInvestment: false
    });
    if (apiPath === "/meta") return sendJson(response, { draftCount: 0, months: [], tags: [] });
    if (apiPath === "/entries") {
      const listed = url.searchParams.get("favorite") === "1" ? isFavorite : true;
      return sendJson(response, { entries: listed ? [{ ...entry, isFavorite }] : [], hasMore: false });
    }
    const detailMatch = apiPath.match(/^\/entries\/(\d+)$/);
    if (detailMatch && request.method === "GET") return sendJson(response, { entry: { ...entry, isFavorite } });
    const favoriteMatch = apiPath.match(/^\/entries\/(\d+)\/favorite$/);
    if (favoriteMatch && request.method === "POST") {
      isFavorite = true;
      return sendJson(response, { ok: true, isFavorite });
    }
    if (favoriteMatch && request.method === "DELETE") {
      isFavorite = false;
      return sendJson(response, { ok: true, isFavorite });
    }
    return sendJson(response, {});
  }
  if (url.pathname === "/assets/pwa-auto-update.js") {
    response.writeHead(200, { "content-type": contentTypes[".js"], "cache-control": "no-store" });
    response.end(await readFile(updaterPath));
    return;
  }
  const relativePath = url.pathname.startsWith("/diary/")
    ? (url.pathname === "/diary/" || url.pathname === "/diary/favorites/" ? "index.html" : url.pathname.slice("/diary/".length))
    : "";
  const target = resolve(publicRoot, relativePath);
  if (target === publicRoot || (!target.startsWith(`${publicRoot}${sep}`) && target !== publicRoot)) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": contentTypes[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end();
  }
});

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

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

async function run(browserType, name, executablePath, contextOptions = {}) {
  isFavorite = false;
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#app-view:not([hidden])");

    await page.click("[data-entry-id=\"1\"]");
    await page.waitForSelector("#entry-dialog[open]");
    const outlineState = await page.locator("#favorite-entry-button").evaluate((button) => ({
      pressed: button.getAttribute("aria-pressed"),
      label: button.getAttribute("aria-label"),
      title: button.title
    }));
    assert.deepEqual(outlineState, { pressed: "false", label: "お気に入りに追加", title: "お気に入りに追加" }, `${name}: 未登録星`);
    await page.click("#favorite-entry-button");
    await page.waitForSelector("#favorite-entry-button[aria-pressed=\"true\"]");
    assert.equal(await page.locator("#favorite-entry-button").getAttribute("aria-label"), "お気に入りから解除", `${name}: 登録後ラベル`);

    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("#entry-dialog")?.open);
    await page.click("#favorites-link");
    await page.waitForURL(/\/diary\/favorites\/?$/);
    await page.waitForSelector("#entry-list [data-entry-id=\"1\"]");
    await page.click("[data-entry-id=\"1\"]");
    await page.waitForSelector("#entry-dialog[open]");
    await page.click("#favorite-entry-button");
    await page.waitForSelector("#favorite-entry-button[aria-pressed=\"false\"]");
    await page.waitForFunction(() => !document.querySelector('#entry-list [data-entry-id="1"]'));

    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("#entry-dialog")?.open);
    assert.match(page.url(), /\/diary\/favorites\/?$/i, `${name}: 1回目Backで一覧`);
    await page.goBack();
    await page.waitForURL(/\/diary\/?$/);
    assert.match(page.url(), /\/diary\/?$/i, `${name}: 2回目Backで日記`);
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await run(chromium, "Chromium", chromiumPath);
  await run(firefox, "Firefox", firefoxPath);
  await run(chromium, "Touch", chromiumPath, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  process.stdout.write("Diary favorite star toggle and Back flow passed in Chromium, Firefox, and touch emulation.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
