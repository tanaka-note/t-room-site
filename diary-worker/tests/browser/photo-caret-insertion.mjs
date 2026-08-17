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
const markerPattern = /\[\[写真:[0-9a-f-]{36}\]\]/g;

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
    ? [...playwrightFirefox, "C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"]
    : ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

async function openEditor(page) {
  await page.click("#new-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
}

async function discardEditor(page) {
  await page.click("#cancel-entry-button");
  if (await page.locator("#editor-leave-dialog").evaluate((node) => node.open)) {
    await page.click("#editor-leave-discard");
  }
  await page.waitForFunction(() => !document.querySelector("#editor-dialog")?.open);
}

async function setEditorCaret(page, html, path, offset) {
  await page.evaluate(({ html, path, offset }) => {
    const editor = document.querySelector("#entry-content");
    editor.innerHTML = html;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    let node = editor;
    for (const index of path) node = node.childNodes[index];
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, { html, path, offset });
}

async function addPhotos(page, names, { endComposition = false } = {}) {
  const before = await page.locator("#editor-photo-list .editor-photo-card").count();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#add-photo-button");
  const chooser = await chooserPromise;
  await chooser.setFiles(names.map((name) => ({ name, mimeType: "image/png", buffer: validPng })));
  if (endComposition) {
    await page.evaluate(() => document.querySelector("#entry-content").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "語" })));
  }
  await page.waitForFunction((count) => document.querySelectorAll("#editor-photo-list .editor-photo-card").length === count, before + names.length);
  return page.locator("#entry-content").textContent();
}

function assertMarkersInOrder(content, expectedCount, label) {
  const markers = content.match(markerPattern) || [];
  assert.equal(markers.length, expectedCount, `${label}: 写真マーカー数`);
  for (let index = 1; index < markers.length; index += 1) {
    assert.ok(content.indexOf(markers[index - 1]) < content.indexOf(markers[index]), `${label}: 複数写真の順番`);
  }
  return markers;
}

async function runScenarios(browserType, name, executablePath, contextOptions = {}) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...contextOptions });
    await page.goto(`${origin}/diary/`);
    await page.waitForSelector("#app-view:not([hidden])");

    await openEditor(page);
    await setEditorCaret(page, "ABC", [0], 3);
    let content = await addPhotos(page, ["single.png"]);
    let markers = assertMarkersInOrder(content, 1, `${name} single`);
    assert.equal(content, `ABC\n${markers[0]}`, `${name}: 単一行文末`);
    await discardEditor(page);

    await openEditor(page);
    await setEditorCaret(page, "<div>1行目</div><p>2行目</p><div>3行目</div>", [2, 0], 3);
    const legacyRangeLength = await page.evaluate(() => {
      const editor = document.querySelector("#entry-content");
      const caret = window.getSelection().getRangeAt(0);
      const before = document.createRange();
      before.selectNodeContents(editor);
      before.setEnd(caret.startContainer, caret.startOffset);
      return before.toString().length;
    });
    assert.ok(legacyRangeLength < "1行目\n2行目\n3行目".length, `${name}: 旧DOM Range座標の段落改行欠落を再現`);
    content = await addPhotos(page, ["paragraph.png"]);
    markers = assertMarkersInOrder(content, 1, `${name} paragraph`);
    assert.equal(content, `1行目\n2行目\n3行目\n${markers[0]}`, `${name}: DIV/P段落文末`);
    await discardEditor(page);

    await openEditor(page);
    await setEditorCaret(page, "<div>AAA</div><div><br></div><div>BBB</div>", [2, 0], 3);
    content = await addPhotos(page, ["blank.png"]);
    markers = assertMarkersInOrder(content, 1, `${name} blank`);
    assert.equal(content, `AAA\n\nBBB\n${markers[0]}`, `${name}: 空行を含む文末`);
    await discardEditor(page);

    await openEditor(page);
    await setEditorCaret(page, "ABCDEF", [0], 3);
    content = await addPhotos(page, ["middle.png"]);
    markers = assertMarkersInOrder(content, 1, `${name} middle`);
    assert.equal(content, `ABC\n${markers[0]}\nDEF`, `${name}: 文中caret`);
    await discardEditor(page);

    await openEditor(page);
    await setEditorCaret(page, "ABC", [0], 3);
    content = await addPhotos(page, ["first.png", "second.png"]);
    markers = assertMarkersInOrder(content, 2, `${name} multiple`);
    assert.equal(content, `ABC\n${markers.join("")}`, `${name}: 複数写真`);
    await page.keyboard.type("DEF");
    content = await addPhotos(page, ["third.png"]);
    markers = assertMarkersInOrder(content, 3, `${name} sequence`);
    assert.ok(content.indexOf("ABC") < content.indexOf(markers[0]));
    assert.ok(content.indexOf(markers[1]) < content.indexOf("DEF"));
    assert.ok(content.indexOf("DEF") < content.indexOf(markers[2]), `${name}: 写真→文章→写真の操作順`);
    await discardEditor(page);

    await openEditor(page);
    const existing = "[[写真:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]]";
    const existingContent = `AAA\n${existing}\nBBB`;
    await setEditorCaret(page, existingContent, [0], existingContent.length);
    content = await addPhotos(page, ["existing.png"]);
    markers = assertMarkersInOrder(content, 2, `${name} existing`);
    assert.ok(content.endsWith(markers[1]), `${name}: 既存写真後の文末`);
    await discardEditor(page);

    await openEditor(page);
    await setEditorCaret(page, '<span class="diary-text-bold">AB</span><span class="diary-text-color-red">CD</span>', [0, 0], 2);
    content = await addPhotos(page, ["rich.png"]);
    markers = assertMarkersInOrder(content, 1, `${name} rich`);
    assert.equal(content, `AB\n${markers[0]}\nCD`, `${name}: rich text位置`);
    const richState = await page.evaluate(() => ({
      bold: document.querySelector("#entry-content .diary-text-bold")?.textContent,
      red: document.querySelector("#entry-content .diary-text-color-red")?.textContent
    }));
    assert.deepEqual(richState, { bold: "AB", red: "CD" }, `${name}: 書式run維持`);
    await discardEditor(page);

    await openEditor(page);
    await setEditorCaret(page, "日本語", [0], 3);
    await page.evaluate(() => document.querySelector("#entry-content").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "語" })));
    content = await addPhotos(page, ["ime.png"], { endComposition: true });
    markers = assertMarkersInOrder(content, 1, `${name} IME`);
    assert.equal(content, `日本語\n${markers[0]}`, `${name}: IME終了時の文末`);
    await discardEditor(page);
  } finally {
    await browser.close();
  }
}

try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await runScenarios(chromium, "Chromium", chromiumPath);
  await runScenarios(firefox, "Firefox", firefoxPath);
  await runScenarios(chromium, "Touch", chromiumPath, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  process.stdout.write("Photo caret insertion passed for single line, blocks, blank lines, repeated photos, existing markers, rich text, IME, Chromium, Firefox, and touch.\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
