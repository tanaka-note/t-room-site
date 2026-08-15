import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, firefox } = require("playwright");
const publicRoot = fileURLToPath(new URL("../../public/", import.meta.url));
const staticFiles = new Map([
  ["/diary/", ["index.html", "text/html; charset=utf-8"]],
  ["/diary/diary.js", ["diary.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary.css", ["diary.css", "text/css; charset=utf-8"]],
  ["/diary/troom-date-picker.js", ["troom-date-picker.js", "text/javascript; charset=utf-8"]],
  ["/diary/troom-date-picker.css", ["troom-date-picker.css", "text/css; charset=utf-8"]]
]);
const validPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    const body = apiPath === "/session"
      ? {
          authenticated: true,
          role: "admin",
          accountName: "テスト",
          householdId: "main-household",
          activeHouseholdId: "main-household",
          canManageEntries: true,
          canViewTrash: true,
          canPermanentlyDelete: true,
          canViewInvestment: false
        }
      : apiPath === "/meta"
        ? { draftCount: 0, months: [], tags: [] }
        : apiPath === "/entries"
          ? { entries: [], hasMore: false }
          : {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
    return;
  }
  const route = staticFiles.get(url.pathname);
  if (route) {
    response.writeHead(200, { "content-type": route[1], "cache-control": "no-store" });
    response.end(await readFile(`${publicRoot}/${route[0]}`));
    return;
  }
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end("");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function browserExecutable(name) {
  const configured = process.env[`TROOM_${name.toUpperCase()}_EXECUTABLE`];
  if (configured) return configured;
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
  const playwrightFirefox = name === "firefox" && playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("firefox-"))
        .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
        .map((entry) => join(playwrightRoot, entry.name, "firefox", "firefox.exe"))
    : [];
  const candidates = name === "firefox"
    ? [
        ...playwrightFirefox,
        "C:/Program Files/Mozilla Firefox/firefox.exe",
        "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"
      ]
    : [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
      ];
  return candidates.find(existsSync) || null;
}

async function openEditor(page) {
  await page.click("#new-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
}

async function waitForDialogClosed(page, selector) {
  await page.waitForFunction((value) => !document.querySelector(value)?.open, selector);
}

async function runDesktop(browserType, name, executablePath) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${origin}/diary/`);
    await page.waitForSelector("#app-view:not([hidden])");

    await openEditor(page);
    const cleanCancelBubbled = await page.evaluate(() => {
      const input = document.querySelector("#photo-input");
      const editor = document.querySelector("#editor-dialog");
      let reachedEditorCapture = false;
      editor.addEventListener("cancel", () => { reachedEditorCapture = true; }, { once: true, capture: true });
      input.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
      return reachedEditorCapture;
    });
    await page.waitForTimeout(100);
    const cleanCancel = await page.evaluate(() => ({
      editorOpen: document.querySelector("#editor-dialog").open,
      leaveOpen: document.querySelector("#editor-leave-dialog").open
    }));
    assert.equal(cleanCancelBubbled, true, `${name}: input cancel must reproduce an event path through editor`);
    assert.equal(cleanCancel.editorOpen, true, `${name}: clean input cancel must not close editor`);
    assert.equal(cleanCancel.leaveOpen, false, `${name}: clean input cancel must not open leave confirmation`);

    await page.fill("#entry-title", "入力を維持するタイトル");
    const dirtyCancel = await page.evaluate(() => {
      const input = document.querySelector("#photo-input");
      const editor = document.querySelector("#editor-dialog");
      const leave = document.querySelector("#editor-leave-dialog");
      input.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
      return { editorOpen: editor.open, leaveOpen: leave.open, title: document.querySelector("#entry-title").value };
    });
    assert.equal(dirtyCancel.editorOpen, true, `${name}: dirty input cancel must not close editor`);
    assert.equal(dirtyCancel.leaveOpen, false, `${name}: dirty input cancel must not open leave confirmation`);
    assert.equal(dirtyCancel.title, "入力を維持するタイトル", `${name}: input cancel must retain fields`);

    await page.evaluate(() => {
      document.querySelector("#editor-dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    await page.waitForSelector("#editor-leave-dialog[open]");
    await page.click("#editor-leave-cancel");
    assert.equal(await page.locator("#editor-dialog").evaluate((node) => node.open), true, `${name}: own dialog cancel follows normal dirty close flow`);

    await page.evaluate(() => {
      document.querySelector("#editor-dialog").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(await page.locator("#editor-dialog").evaluate((node) => node.open), true, `${name}: picker-return click alone must not close editor`);

    await page.click("#cancel-entry-button");
    await page.waitForSelector("#editor-leave-dialog[open]");
    await page.click("#editor-leave-discard");
    await waitForDialogClosed(page, "#editor-dialog");

    await openEditor(page);
    await page.mouse.move(3, 3);
    await page.mouse.down();
    await page.mouse.up();
    await waitForDialogClosed(page, "#editor-dialog");

    await openEditor(page);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.click("#add-photo-button");
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "selected.png", mimeType: "image/png", buffer: validPng });
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    assert.equal(await page.locator("#editor-dialog").evaluate((node) => node.open), true, `${name}: successful selection must retain editor`);
  } finally {
    await browser.close();
  }
}

async function runTouch(executablePath) {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${origin}/diary/`);
    await page.waitForSelector("#app-view:not([hidden])");
    await openEditor(page);
    await page.evaluate(() => {
      document.querySelector("#photo-input").dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#editor-dialog").evaluate((node) => node.open), true, "Touch: input cancel must retain editor");
    assert.equal(await page.locator("#editor-leave-dialog").evaluate((node) => node.open), false, "Touch: input cancel must not open leave confirmation");
  } finally {
    await browser.close();
  }
}

try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Set TROOM_CHROMIUM_EXECUTABLE and TROOM_FIREFOX_EXECUTABLE to installed browser executables.");
  await runDesktop(chromium, "Chromium", chromiumPath);
  await runDesktop(firefox, "Firefox", firefoxPath);
  await runTouch(chromiumPath);
  process.stdout.write("File-picker cancel bubbling passed in Chromium, Firefox, and touch emulation.\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
