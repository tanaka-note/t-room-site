import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require("playwright");
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

function japanMonth() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function shiftMonth(value, offset) {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function postMonthHeading(value) {
  const [year, month] = value.split("-").map(Number);
  return year === Number(japanMonth().slice(0, 4)) ? `${month}月の投稿` : `${year}年${month}月の投稿`;
}

function createEntries(month, startId) {
  return Array.from({ length: 9 }, (_, index) => ({
    id: startId + index,
    entryDate: `${month}-${String(28 - index).padStart(2, "0")}`,
    title: `${month} 月別移動確認 ${index + 1}`,
    content: `描画完了後の見出し移動を確認する日記 ${index + 1}。`.repeat(5),
    authorName: "テスト",
    tags: [],
    status: "published",
    deletedAt: null,
    isFavorite: false,
    revision: 1,
    photos: []
  }));
}

const currentMonth = japanMonth();
const targetMonth = shiftMonth(currentMonth, -1);
const olderMonth = shiftMonth(currentMonth, -2);
const entriesByMonth = new Map([
  [currentMonth, createEntries(currentMonth, 100)],
  [targetMonth, createEntries(targetMonth, 200)],
  [olderMonth, createEntries(olderMonth, 300)]
]);

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (apiPath === "/session") return sendJson(response, {
      authenticated: true,
      role: "admin",
      accountName: "年月移動テスト",
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
      months: [...entriesByMonth].map(([value, entries]) => ({ value, count: entries.length })),
      tags: []
    });
    if (apiPath === "/entries") {
      const month = url.searchParams.get("month") || currentMonth;
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 20);
      const entries = entriesByMonth.get(month) || [];
      if (month === targetMonth) await delay(180);
      return sendJson(response, {
        entries: entries.slice(offset, offset + limit),
        hasMore: offset + limit < entries.length
      });
    }
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
  const prefixes = name === "firefox" ? ["firefox-"] : name === "webkit" ? ["webkit-"] : ["chromium-"];
  const bundled = playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory() && prefixes.some((prefix) => candidate.name.startsWith(prefix)))
        .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
        .flatMap((candidate) => name === "firefox"
          ? [join(playwrightRoot, candidate.name, "firefox", "firefox.exe")]
          : name === "webkit"
            ? [join(playwrightRoot, candidate.name, "Playwright.exe")]
            : [join(playwrightRoot, candidate.name, "chrome-win", "chrome.exe")])
    : [];
  const candidates = name === "firefox"
    ? [...bundled, "C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"]
    : name === "webkit"
      ? bundled
      : [...bundled, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

async function waitForMonth(page, month, firstEntryId) {
  await page.waitForFunction(({ expectedMonth, expectedId }) => (
    document.querySelector(`[data-month="${expectedMonth}"]`)?.getAttribute("aria-pressed") === "true"
      && document.querySelector(`[data-entry-id="${expectedId}"]`)
  ), { expectedMonth: month, expectedId: String(firstEntryId) });
}

async function assertHeadingPosition(page, label) {
  await page.waitForFunction(() => {
    const heading = document.querySelector("#diary-recent-title");
    const header = document.querySelector("#site-header");
    if (!heading || !header) return false;
    return Math.abs(heading.getBoundingClientRect().top - header.offsetHeight - 12) <= 2;
  });
  const position = await page.evaluate(() => ({
    headingTop: document.querySelector("#diary-recent-title").getBoundingClientRect().top,
    headerHeight: document.querySelector("#site-header").offsetHeight,
    scrollY: window.scrollY
  }));
  assert.ok(position.scrollY > 0, `${label}: 一覧見出しまでページを移動`);
  assert.ok(Math.abs(position.headingTop - position.headerHeight - 12) <= 2, `${label}: 見出し位置 ${JSON.stringify(position)}`);
}

async function run(browserType, name, executablePath, contextOptions = {}) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
      ...contextOptions
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const originalScrollTo = window.scrollTo.bind(window);
      window.__monthlyNavigationScrolls = [];
      window.scrollTo = (...args) => {
        window.__monthlyNavigationScrolls.push({
          renderedEntryId: document.querySelector("#entry-list [data-entry-id]")?.dataset.entryId || "",
          heading: document.querySelector("#diary-recent-title")?.textContent || ""
        });
        return originalScrollTo(...args);
      };
    });
    await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#app-view:not([hidden])");
    await waitForMonth(page, currentMonth, 100);

    await page.locator(`[data-month="${targetMonth}"]`).click();
    await waitForMonth(page, targetMonth, 200);
    assert.equal(await page.locator("#diary-recent-title").textContent(), postMonthHeading(targetMonth), `${name}: 別ページの年月見出し`);
    await assertHeadingPosition(page, `${name}: 別ページ`);
    const differentPageScrolls = await page.evaluate(() => window.__monthlyNavigationScrolls);
    assert.ok(differentPageScrolls.length > 0, `${name}: 別ページ描画後にスクロール`);
    assert.equal(differentPageScrolls.at(-1).renderedEntryId, "200", `${name}: 対象月の記事を描画してからスクロール`);

    await page.evaluate(() => {
      window.__monthlyNavigationScrolls = [];
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      window.__monthlyNavigationScrolls = [];
    });
    await page.locator(`[data-month="${targetMonth}"]`).click();
    await assertHeadingPosition(page, `${name}: 同一ページ`);
    const samePageScrolls = await page.evaluate(() => window.__monthlyNavigationScrolls);
    assert.ok(samePageScrolls.length > 0, `${name}: 同一ページでも見出しへスクロール`);
    assert.equal(samePageScrolls.at(-1).renderedEntryId, "200", `${name}: 同一ページの記事を維持`);
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
  const webkitPath = browserExecutable("webkit");
  if (!chromiumPath || !firefoxPath || !webkitPath) throw new Error("Chromium/Firefox/WebKit executable is required.");
  await run(chromium, "Chromium", chromiumPath);
  await run(firefox, "Firefox", firefoxPath);
  await run(webkit, "WebKit", webkitPath);
  await run(chromium, "Touch Chromium", chromiumPath, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  process.stdout.write("Diary monthly navigation passed for same/different pages in Chromium, Firefox, WebKit, and touch Chromium.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
