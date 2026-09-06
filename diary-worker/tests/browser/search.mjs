import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

const photoId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const body = "朝".repeat(190) + "ふゆと公園へ。<b> & A+B %_ 😀 https://example.test/公園" + "道".repeat(240) + "お弁当と👨‍👩‍👧‍👦。" + "夕".repeat(180) + "[[写真:" + photoId + "]]";
const park = body.indexOf("公園");
const entries = Array.from({ length: 43 }, (_, index) => ({
  id: index + 1, entryDate: "2026-08-12", title: "ふゆと公園 <script> & " + index,
  content: body, contentFormat: { version: 1, runs: [
    { start: park, end: park + 1, bold: true, color: "red" },
    { start: park + 1, end: park + 2, italic: true, underline: true, color: "blue" }
  ] },
  authorName: "検索テスト", tags: ["外出"], status: "published", deletedAt: null,
  isFavorite: false, revision: 1,
  photos: [{ id: photoId, displayUrl: "/diary/icons/favicon-64-v4.png", fileName: "写真.png" }]
}));
const requests = [];
entries.push({ ...entries[0], id: 44, title: "タイトル限定", content: "本文の先頭。".repeat(60), contentFormat: null, photos: [] });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const path = url.pathname.slice("/diary/api".length);
    if (path === "/session") return sendJson(response, {
      authenticated: true, role: "admin", accountName: "検索テスト", householdId: "main-household",
      activeHouseholdId: "main-household", isGlobalOwner: false, canManageEntries: true,
      canViewTrash: true, canPermanentlyDelete: true, canViewInvestment: false
    });
    if (path === "/meta") return sendJson(response, { draftCount: 0, months: [], tags: [{ value: "外出", count: 43 }] });
    if (path === "/entries") {
      requests.push(Object.fromEntries(url.searchParams));
      const words = (url.searchParams.get("q") || "").trim().split(/\s+/).filter(Boolean);
      const source = entries.filter((entry) => words.every((word) => entry.title.includes(word) || entry.content.includes(word)));
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 20);
      return sendJson(response, { entries: source.slice(offset, offset + limit), hasMore: offset + limit < source.length });
    }
    const detail = path.match(/^\/entries\/(\d+)$/);
    if (detail) return sendJson(response, { entry: entries[Number(detail[1]) - 1] });
    return sendJson(response, {});
  }
  if (url.pathname === "/assets/pwa-auto-update.js") return sendFile(response, updaterPath);
  if (url.pathname === "/security/passkey-client.js") return sendFile(response, passkeyClientPath);
  const target = resolve(publicRoot, url.pathname === "/diary/" ? "index.html" : url.pathname.replace(/^\/diary\//, ""));
  if (!target.startsWith(publicRoot + sep)) return response.writeHead(404).end();
  try { return await sendFile(response, target); } catch { return response.writeHead(404).end(); }
});
function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
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

async function run(browserType, name, options = {}) {
  const executablePath = browserExecutable(name === "Touch Chromium" ? "chromium" : name.toLowerCase());
  assert.ok(executablePath, `${name} executable required`);
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 }, ...options });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#entry-list [data-entry-id]");
    assert.equal(await page.locator("#entry-list [data-entry-id]").count(), 5);
    assert.equal(await page.locator("mark.diary-search-match").count(), 0);
    const normalSummary = await page.locator("#entry-list .diary-entry-button > p").first().textContent();
    assert.equal(normalSummary, "朝".repeat(130) + "…");

    async function search(query, expected = 20) {
      await page.fill("#diary-search-input", query);
      await page.waitForResponse((response) => response.url().includes("/diary/api/entries?") && response.request().method() === "GET");
      await page.waitForFunction((count) => document.querySelectorAll("#entry-list [data-entry-id]").length === count, expected);
    }
    await search(" ふゆ　 公園  お弁当  ふゆ ");
    assert.equal(requests.at(-1).q, "ふゆ 公園 お弁当");
    assert.equal(requests.at(-1).limit, "20");
    const firstCard = page.locator("#entry-list .diary-entry-button").first();
    assert.deepEqual(await firstCard.locator("h3 mark").allTextContents(), ["ふゆ", "公園"]);
    const excerpt = await firstCard.locator("p").textContent();
    assert.ok([...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(excerpt)].length <= 160);
    for (const term of ["ふゆ", "公園", "お弁当"]) assert.ok(excerpt.includes(term));
    assert.ok(excerpt.indexOf("公園") < excerpt.indexOf("お弁当"));
    assert.ok(excerpt.split("…").filter(Boolean).length <= 2);
    assert.equal(await firstCard.locator("h3 script").count(), 0);

    await page.locator("#load-more-button").click();
    await page.waitForFunction(() => document.querySelectorAll("#entry-list [data-entry-id]").length === 40);
    const target = page.locator('[data-entry-id="29"]');
    await target.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(150);
    const before = await target.evaluate((node) => ({ top: node.getBoundingClientRect().top, scrollY: window.scrollY }));
    await target.click();
    await page.waitForSelector("#entry-dialog[open]");
    await page.waitForSelector("#detail-content mark");
    assert.deepEqual(await page.locator("#detail-title mark").allTextContents(), ["ふゆ", "公園"]);
    const detail = page.locator("#detail-content");
    const savedText = body.replace(/\[\[写真:[0-9a-f-]{36}\]\]/gi, "");
    assert.equal(await detail.textContent(), savedText);
    assert.equal(await detail.locator(".entry-photo").count(), 1);
    const styled = await detail.locator("mark").evaluateAll((marks) => marks.filter((mark) => ["公", "園"].includes(mark.textContent)).map((mark) => ({
      text: mark.textContent, color: getComputedStyle(mark).color, weight: getComputedStyle(mark).fontWeight,
      italic: getComputedStyle(mark).fontStyle, underline: getComputedStyle(mark).textDecorationLine,
      background: getComputedStyle(mark).backgroundColor
    })));
    assert.ok(styled.some((mark) => mark.text === "公" && mark.color === "rgb(180, 35, 24)" && Number(mark.weight) >= 600));
    assert.ok(styled.some((mark) => mark.text === "園" && mark.color === "rgb(23, 92, 211)" && mark.italic === "italic" && mark.underline.includes("underline")));
    assert.ok(styled.every((mark) => mark.background !== "rgba(0, 0, 0, 0)"));
    assert.ok(await detail.locator('a[href^="https://example.test/"] mark').count());
    assert.equal(await detail.locator("script, b").count(), 0);

    // Reapplying and clearing marks must preserve the original nodes, handlers and content.
    await detail.evaluate(async (root) => {
      const { highlightSearchTerms } = await import("/diary/diary-search.js");
      const photo = root.querySelector("img");
      const link = root.querySelector("a");
      window.__searchPreservedNodes = { photo, link };
      highlightSearchTerms(root, ["A+B", "%_", "😀", "👨‍👩‍👧‍👦", "<b>"]);
      highlightSearchTerms(root, ["A+B", "%_", "😀", "👨‍👩‍👧‍👦", "<b>"]);
    });
    assert.deepEqual(await detail.locator("mark").allTextContents(), ["<b>", "A+B", "%_", "😀", "👨‍👩‍👧‍👦"]);
    assert.equal(await detail.locator("mark mark").count(), 0);
    assert.equal(await detail.textContent(), savedText);
    assert.ok(await detail.evaluate(async (root) => {
      const { highlightSearchTerms } = await import("/diary/diary-search.js");
      highlightSearchTerms(root, []);
      return !root.querySelector("mark") && root.querySelector("img") === window.__searchPreservedNodes.photo
        && root.querySelector("a") === window.__searchPreservedNodes.link;
    }));

    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("#entry-dialog").open);
    const after = await target.evaluate((node) => ({ top: node.getBoundingClientRect().top, scrollY: window.scrollY }));
    assert.ok(Math.abs(before.top - after.top) <= 3, `${name} return position`);
    assert.ok(Math.abs(before.scrollY - after.scrollY) <= 3, `${name} scroll restoration`);
    assert.equal(await page.locator("#entry-list [data-entry-id]").count(), 40);
    assert.equal(await page.locator("#diary-search-input").inputValue(), " ふゆ　 公園  お弁当  ふゆ ");
    await page.locator("#load-more-button").click();
    await page.waitForFunction(() => document.querySelectorAll("#entry-list [data-entry-id]").length === 43);
    assert.equal(new Set(await page.locator("#entry-list [data-entry-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.entryId))).size, 43);
    assert.ok(await page.locator("#load-more-button").isHidden());
    await search("A+B");
    assert.equal(await page.locator("#entry-list h3 mark").count(), 0);
    assert.deepEqual(await page.locator("#entry-list .diary-entry-button > p").first().locator("mark").allTextContents(), ["A+B"]);
    await search("タイトル限定", 1);
    assert.deepEqual(await page.locator("#entry-list h3 mark").allTextContents(), ["タイトル限定"]);
    const titleOnlySummary = await page.locator("#entry-list .diary-entry-button > p").textContent();
    assert.ok(titleOnlySummary.startsWith("本文の先頭。"));
    assert.equal([...titleOnlySummary].length, 160);
    assert.equal(await page.locator("#entry-list p mark").count(), 0);
    await search("存在しない検索語", 0);
    assert.equal(await page.locator("#entry-list mark").count(), 0);
    await search(" 　 ", 5);
    assert.equal(requests.at(-1).q, undefined);
    assert.equal(await page.locator("#entry-list mark").count(), 0);
    assert.equal(await page.locator("#entry-list .diary-entry-button > p").first().textContent(), normalSummary);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${name}: search excerpts, highlight formatting/links/photos, 20-item paging and Back passed.`);
  } finally {
    await browser.close();
  }
}

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await run(chromium, "Chromium");
  await run(firefox, "Firefox");
  await run(webkit, "WebKit");
  await run(chromium, "Touch Chromium", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
} finally {
  await new Promise((done) => server.close(done));
}
