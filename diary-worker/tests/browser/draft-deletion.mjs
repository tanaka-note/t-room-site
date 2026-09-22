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
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

let draft = null;
let deleteBodies = [];

function resetData() {
  draft = {
    id: 42,
    entryDate: "2026-09-23",
    title: "削除対象の下書き",
    content: "下書き本文",
    contentFormat: null,
    authorName: "テスト",
    tags: ["下書き"],
    status: "draft",
    draftOfEntryId: null,
    excludedPhotoIds: [],
    deletedAt: null,
    revision: 3,
    photos: []
  };
  deleteBodies = [];
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
      draftCount: draft ? 1 : 0,
      months: [],
      tags: []
    });
    if (apiPath === "/entries" && request.method === "GET") {
      const entries = url.searchParams.get("draft") === "1" && draft ? [draft] : [];
      return sendJson(response, { entries, hasMore: false });
    }
    if (apiPath === "/entries/42" && request.method === "GET") {
      return draft ? sendJson(response, { entry: draft }) : sendJson(response, { error: "not found" }, 404);
    }
    if (apiPath === "/drafts/42" && request.method === "DELETE") {
      deleteBodies.push(await jsonBody(request));
      draft = null;
      return sendJson(response, { ok: true, cleanupPending: false });
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

async function run(browser, label, contextOptions) {
  resetData();
  const context = await browser.newContext({ serviceWorkers: "block", ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#app-view:not([hidden])");

  await page.click("#new-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
  assert.equal(await page.locator("#delete-draft-button").isHidden(), true, `${label}: unsaved entry hides delete`);
  await page.click("#cancel-entry-button");
  await page.waitForFunction(() => !document.querySelector("#editor-dialog").open);

  await page.click("#draft-button");
  await page.click('[data-entry-id="42"]');
  await page.waitForSelector("#editor-dialog[open]");
  const deleteButton = page.locator("#delete-draft-button");
  assert.equal(await deleteButton.isVisible(), true, `${label}: saved draft shows delete`);
  const deleteBox = await deleteButton.boundingBox();
  const cancelBox = await page.locator("#cancel-entry-button").boundingBox();
  assert.ok(deleteBox && cancelBox, `${label}: editor actions are laid out`);
  if (contextOptions.isMobile) {
    assert.ok(deleteBox.width > 300, `${label}: delete action remains full-width and operable`);
  } else {
    assert.ok(deleteBox.x < cancelBox.x, `${label}: destructive action is separated from save actions`);
  }

  await deleteButton.click();
  await page.waitForSelector("#delete-confirm-dialog[open]");
  assert.equal(await page.locator("#delete-confirm-title").textContent(), "この下書きを削除しますか？");
  await page.click("#delete-confirm-yes");
  await page.waitForFunction(() => !document.querySelector("#editor-dialog").open && !document.querySelector('[data-entry-id="42"]'));
  assert.deepEqual(deleteBodies, [{ revision: 3 }], `${label}: delete uses the saved draft revision`);
  assert.equal(await page.locator("#draft-count").isHidden(), true, `${label}: draft count is refreshed`);
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
  process.stdout.write("Diary draft deletion UI passed in representative desktop and mobile Chromium contexts.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
