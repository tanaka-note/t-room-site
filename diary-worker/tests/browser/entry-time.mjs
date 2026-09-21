import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const publicRoot = resolve(fileURLToPath(new URL("../../public/", import.meta.url)));
const workspace = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const updaterPath = resolve(workspace, "assets/pwa-auto-update.js");
const passkeyClientPath = resolve(workspace, "security-worker/public/passkey-client.js");
const fixedNow = Date.parse("2026-09-20T16:35:00.000Z");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

let entries = [];
let createdBodies = [];
let updatedBodies = [];

function resetData() {
  entries = [
    {
      id: 1, entryDate: "2026-09-21", lastPublishedAt: "2026-09-21T11:15:00.000Z",
      title: "投稿日あり", content: "投稿日あり本文", contentFormat: null, authorName: "テスト",
      tags: [], status: "published", deletedAt: null, isFavorite: false, revision: 1, photos: []
    },
    {
      id: 2, entryDate: "2026-09-20", lastPublishedAt: "2026-09-21T04:13:00.000Z",
      title: "前日の日記", content: "既存本文", contentFormat: null, authorName: "テスト",
      tags: [], status: "published", deletedAt: null, isFavorite: false, revision: 1, photos: []
    }
  ];
  createdBodies = [];
  updatedBodies = [];
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, body, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(await readFile(path));
}

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
    if (apiPath === "/meta") return sendJson(response, {
      draftCount: 0,
      months: [{ value: "2026-09", count: entries.length }],
      tags: []
    });
    if (apiPath === "/entries" && request.method === "GET") {
      return sendJson(response, { entries, hasMore: false });
    }
    if (apiPath === "/entries" && request.method === "POST") {
      const body = await jsonBody(request);
      createdBodies.push(body);
      const entry = {
        id: 3,
        ...body,
        lastPublishedAt: "2026-09-20T16:35:00.000Z",
        contentFormat: body.contentFormat || null,
        authorName: "テスト",
        status: body.status || "published",
        deletedAt: null,
        isFavorite: false,
        revision: 1,
        photos: []
      };
      entries.unshift(entry);
      return sendJson(response, { entry });
    }
    const detailMatch = apiPath.match(/^\/entries\/(\d+)$/);
    if (detailMatch && request.method === "GET") {
      const entry = entries.find((item) => item.id === Number(detailMatch[1]));
      return entry ? sendJson(response, { entry }) : sendJson(response, { error: "not found" }, 404);
    }
    if (detailMatch && request.method === "PUT") {
      const body = await jsonBody(request);
      updatedBodies.push(body);
      const index = entries.findIndex((item) => item.id === Number(detailMatch[1]));
      const entry = {
        ...entries[index],
        ...body,
        id: entries[index].id,
        lastPublishedAt: "2026-09-20T16:36:00.000Z",
        revision: entries[index].revision + 1
      };
      entries[index] = entry;
      return sendJson(response, { entry });
    }
    return sendJson(response, {});
  }

  if (url.pathname === "/assets/pwa-auto-update.js") return sendFile(response, updaterPath);
  if (url.pathname === "/security/passkey-client.js") return sendFile(response, passkeyClientPath);
  const diaryRoute = /^\/diary\/(?:|favorites\/|tags\/|tag\/[^/]+\/?)$/.test(url.pathname);
  const relativePath = diaryRoute ? "index.html" : url.pathname.replace(/^\/diary\//, "");
  const target = resolve(publicRoot, relativePath);
  if (!target.startsWith(`${publicRoot}${sep}`) && target !== publicRoot) return response.writeHead(404).end();
  try {
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    return sendFile(response, target);
  } catch {
    return response.writeHead(404).end();
  }
});

function browserExecutable() {
  return [
    process.env.TROOM_CHROMIUM_EXECUTABLE,
    chromium.executablePath(),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ].filter(Boolean).find(existsSync) || null;
}

async function assertEditorLayout(page, label) {
  const rectangles = await page.evaluate(() => {
    const dialog = document.querySelector("#editor-dialog").getBoundingClientRect();
    const date = document.querySelector("#entry-date").getBoundingClientRect();
    return {
      dialog: { left: dialog.left, right: dialog.right },
      date: { left: date.left, right: date.right, width: date.width }
    };
  });
  assert.ok(rectangles.date.left >= rectangles.dialog.left && rectangles.date.right <= rectangles.dialog.right,
    `${label}: date field stays inside dialog`);
  assert.ok(rectangles.date.width >= 140, `${label}: date field remains operable`);
}

async function run(browser, label, contextOptions) {
  resetData();
  const context = await browser.newContext({ serviceWorkers: "block", ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((timestamp) => {
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [timestamp])); }
      static now() { return timestamp; }
    }
    globalThis.Date = FixedDate;
  }, fixedNow);
  await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#app-view:not([hidden])");

  const card = page.locator('[data-entry-id="1"]');
  assert.match(await card.locator(".entry-date-primary").textContent(), /^2026年9月21日（.）$/, `${label}: diary date is date-only`);
  assert.equal(await card.locator(".entry-published-at").textContent(), "投稿日時：9月21日 20:15", `${label}: UTC publication time is shown in Japan time`);
  const dateFontSize = Number.parseFloat(await card.locator(".entry-date-primary").evaluate((node) => getComputedStyle(node).fontSize));
  const publishedFontSize = Number.parseFloat(await card.locator(".entry-published-at").evaluate((node) => getComputedStyle(node).fontSize));
  assert.ok(dateFontSize > publishedFontSize, `${label}: diary date is visually primary`);

  await card.click();
  await page.waitForSelector("#entry-dialog[open]");
  assert.match(await page.locator("#detail-date").textContent(), /^2026年9月21日（.）$/, `${label}: detail date is date-only`);
  assert.equal(await page.locator("#detail-published-at").textContent(), "投稿日時：9月21日 20:15", `${label}: detail shows publication time separately`);
  await page.click('[data-close-dialog="entry-dialog"]');

  await page.click("#new-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
  assert.equal(await page.locator("#entry-date").inputValue(), "2026-09-21", `${label}: current Japan date default`);
  assert.equal(await page.locator("#entry-time").count(), 0, `${label}: editor has no time input`);
  await assertEditorLayout(page, label);
  await page.locator("#entry-title").fill("新規投稿日テスト");
  await page.locator("#entry-content").fill("新規投稿日本文");
  await page.click("#save-entry-button");
  await page.waitForFunction(() => !document.querySelector("#editor-dialog").open);
  assert.equal(createdBodies.length, 1, `${label}: create request sent`);
  assert.equal("entryTime" in createdBodies[0], false, `${label}: client does not send entryTime`);
  assert.equal("lastPublishedAt" in createdBodies[0], false, `${label}: client cannot set publication time`);

  await page.click('[data-entry-id="3"]');
  await page.waitForSelector("#entry-dialog[open]");
  assert.equal(await page.locator("#detail-published-at").textContent(), "投稿日時：9月21日 01:35", `${label}: created server timestamp is rendered`);
  await page.click("#edit-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
  await page.locator("#entry-date").evaluate((node) => { node.value = "2026-09-19"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click("#save-entry-button");
  await page.waitForFunction(() => !document.querySelector("#editor-dialog").open);
  assert.equal(updatedBodies.at(-1).entryDate, "2026-09-19", `${label}: diary date remains editable`);
  assert.equal("entryTime" in updatedBodies.at(-1), false, `${label}: update does not send entryTime`);
  assert.equal("lastPublishedAt" in updatedBodies.at(-1), false, `${label}: update does not send publication time`);
  assert.deepEqual(errors, [], `${label}: no page errors`);
  await context.close();
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  const executablePath = browserExecutable();
  if (!executablePath) throw new Error("Chromium or Edge executable is required.");
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    await run(browser, "Desktop", { viewport: { width: 1280, height: 800 } });
    await run(browser, "Mobile", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  } finally {
    await browser.close();
  }
  process.stdout.write("Diary date/publication timestamp UI passed in representative desktop and mobile Chromium contexts.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
