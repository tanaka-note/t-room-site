import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const publicRoot = fileURLToPath(new URL("../../public/", import.meta.url));
const validPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const markerPattern = /\[\[写真:[0-9a-f-]{36}\]\]/g;
const staticFiles = new Map([
  ["/diary/", ["index.html", "text/html; charset=utf-8"]],
  ["/diary/diary.js", ["diary.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary-search.js", ["diary-search.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary-weather.js", ["diary-weather.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary-photo-processing.js", ["diary-photo-processing.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary-photo-upload.js", ["diary-photo-upload.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary-rich-text.js", ["diary-rich-text.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary.css", ["diary.css", "text/css; charset=utf-8"]],
  ["/diary/troom-date-picker.js", ["troom-date-picker.js", "text/javascript; charset=utf-8"]],
  ["/diary/troom-date-picker.css", ["troom-date-picker.css", "text/css; charset=utf-8"]],
  ["/test.png", [null, "image/png"]]
]);
const persisted = {
  entries: new Map(),
  stagedPhotoIds: [],
  committedPhotoOwners: new Map(),
  nextEntryId: 1
};

function json(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function entryRecord(id, body, previous = null) {
  const now = new Date().toISOString();
  const photos = [...persisted.committedPhotoOwners.entries()]
    .filter(([, entryId]) => entryId === id)
    .map(([photoId]) => ({
      id: photoId,
      entryId: id,
      fileName: `${photoId}.png`,
      width: 1,
      height: 1,
      thumbnailUrl: "/test.png",
      displayUrl: "/test.png"
    }));
  return {
    id,
    revision: (previous?.revision || 0) + 1,
    status: body.status || "draft",
    entryDate: body.entryDate || "2026-09-25",
    title: body.title || "",
    weather: body.weather || null,
    content: body.content || "",
    contentFormat: body.contentFormat || null,
    tags: body.tags || [],
    authorName: "テスト",
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    photos,
    excludedPhotoIds: body.excludedPhotoIds || []
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (request.method === "GET" && apiPath === "/session") {
      return json(response, {
        authenticated: true,
        role: "admin",
        accountName: "テスト",
        householdId: "main-household",
        activeHouseholdId: "main-household",
        canManageEntries: true,
        canViewTrash: true,
        canPermanentlyDelete: true,
        canViewInvestment: false
      });
    }
    if (request.method === "GET" && apiPath === "/meta") {
      return json(response, {
        draftCount: [...persisted.entries.values()].filter((entry) => entry.status === "draft").length,
        months: [],
        tags: []
      });
    }
    if (request.method === "GET" && apiPath === "/entries") {
      const drafts = url.searchParams.get("draft") === "1";
      const entries = [...persisted.entries.values()].filter((entry) => drafts
        ? entry.status === "draft"
        : entry.status === "published");
      return json(response, { entries, hasMore: false });
    }
    const entryMatch = apiPath.match(/^\/entries\/(\d+)$/);
    if (request.method === "GET" && entryMatch) {
      return json(response, { entry: persisted.entries.get(Number(entryMatch[1])) });
    }
    if (request.method === "POST" && apiPath === "/photo-upload-sessions") {
      return json(response, { uploadSession: { id: "atomic-test-session" } });
    }
    if (request.method === "POST" && apiPath === "/photo-upload-sessions/atomic-test-session/photos") {
      const body = (await readBody(request)).toString("latin1");
      const photoId = body.match(/name="id"\r\n\r\n([^\r\n]+)/)?.[1];
      if (!photoId) return json(response, { error: "photo id missing" }, 400);
      persisted.stagedPhotoIds.push(photoId);
      return json(response, { photo: { id: photoId } });
    }
    if (request.method === "POST" && apiPath === "/photo-upload-sessions/atomic-test-session/commit") {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      for (const photoId of body.photoIds) persisted.committedPhotoOwners.set(photoId, Number(body.entryId));
      return json(response, {
        photos: body.photoIds.map((id) => ({
          id,
          entryId: Number(body.entryId),
          fileName: `${id}.png`,
          width: 1,
          height: 1,
          thumbnailUrl: "/test.png",
          displayUrl: "/test.png"
        }))
      });
    }
    if (request.method === "POST" && apiPath === "/entries") {
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      const id = persisted.nextEntryId++;
      const entry = entryRecord(id, body);
      persisted.entries.set(id, entry);
      return json(response, { entry });
    }
    if (request.method === "PUT" && entryMatch) {
      const id = Number(entryMatch[1]);
      const body = JSON.parse((await readBody(request)).toString("utf8"));
      const entry = entryRecord(id, body, persisted.entries.get(id));
      persisted.entries.set(id, entry);
      return json(response, { entry });
    }
    return json(response, {});
  }
  const route = staticFiles.get(url.pathname);
  if (route) {
    response.writeHead(200, { "content-type": route[1], "cache-control": "no-store" });
    response.end(route[0] ? await readFile(`${publicRoot}/${route[0]}`) : Buffer.from(validPngBase64, "base64"));
    return;
  }
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end("");
});

function markers(value) {
  return String(value || "").match(markerPattern) || [];
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

async function setEditor(page, html, path = [], offset = 0) {
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
    editor.focus();
    document.dispatchEvent(new Event("selectionchange"));
  }, { html, path, offset });
}

async function dropPhotos(page, names) {
  const before = await page.locator("#editor-photo-list .editor-photo-card").count();
  await page.evaluate(({ names, validPngBase64 }) => {
    const bytes = Uint8Array.from(atob(validPngBase64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    for (const name of names) transfer.items.add(new File([bytes], name, { type: "image/png" }));
    const zone = document.querySelector("#photo-drop-zone");
    for (const type of ["dragenter", "dragover", "drop"]) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, { names, validPngBase64 });
  await page.waitForFunction((count) => document.querySelectorAll("#editor-photo-list .editor-photo-card").length === count, before + names.length);
}

async function editorSnapshot(page) {
  return page.locator("#entry-content").evaluate((editor) => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const describeNode = (node) => node?.nodeType === Node.TEXT_NODE
      ? { type: "text", value: node.nodeValue }
      : { type: node?.nodeName || null, marker: node?.dataset?.photoMarker || null };
    return {
      text: editor.textContent,
      html: editor.innerHTML,
      tokens: [...editor.querySelectorAll("[data-photo-marker]")].map((node) => ({
        marker: node.dataset.photoMarker,
        editable: node.getAttribute("contenteditable")
      })),
      selection: range ? {
        collapsed: range.collapsed,
        anchor: describeNode(selection.anchorNode),
        anchorOffset: selection.anchorOffset,
        focus: describeNode(selection.focusNode),
        focusOffset: selection.focusOffset
      } : null
    };
  });
}

function assertAtomicMarkers(snapshot, expectedMarkers, label) {
  assert.deepEqual(markers(snapshot.text), expectedMarkers, `${label}: marker text and order`);
  assert.deepEqual(snapshot.tokens.map((token) => token.marker), expectedMarkers, `${label}: atomic token order`);
  assert.ok(snapshot.tokens.every((token) => token.editable === "false"), `${label}: tokens are non-editable`);
  assert.equal(snapshot.selection?.collapsed, true, `${label}: caret remains collapsed`);
}

async function insertOneCharacterAtATime(page, text, expectedMarkers, label) {
  for (const character of [...text]) {
    await page.keyboard.insertText(character);
    assertAtomicMarkers(await editorSnapshot(page), expectedMarkers, `${label} after ${character}`);
  }
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let browserLabel = "Google Chrome";
try {
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browserLabel = "Playwright Chromium fallback";
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${origin}/diary/`);
  await page.waitForSelector("#app-view:not([hidden])");

  // A: the reported path: one DataTransfer containing multiple files, then typing without another click.
  await openEditor(page);
  await setEditor(page, "", [], 0);
  await dropPhotos(page, ["one.png", "two.png", "three.png"]);
  let snapshot = await editorSnapshot(page);
  let expectedMarkers = markers(snapshot.text);
  assert.equal(expectedMarkers.length, 3, "case A: three complete markers after one drop");
  assertAtomicMarkers(snapshot, expectedMarkers, "case A insertion");
  await insertOneCharacterAtATime(page, "写真のあとに文章を入力します。テスト12345", expectedMarkers, "case A");
  await page.locator("#entry-content").evaluate((editor) => {
    const tokens = editor.querySelectorAll("[data-photo-marker]");
    const selection = window.getSelection();
    const afterLast = document.createRange();
    afterLast.setStartAfter(tokens[tokens.length - 1]);
    afterLast.collapse(true);
    selection.removeAllRanges();
    selection.addRange(afterLast);
  });
  await page.keyboard.press("Backspace");
  assertAtomicMarkers(await editorSnapshot(page), expectedMarkers, "case A protected Backspace");
  await page.locator("#entry-content").evaluate((editor) => {
    const first = editor.querySelector("[data-photo-marker]");
    const selection = window.getSelection();
    const beforeFirst = document.createRange();
    beforeFirst.setStartBefore(first);
    beforeFirst.collapse(true);
    selection.removeAllRanges();
    selection.addRange(beforeFirst);
  });
  await page.keyboard.press("Delete");
  assertAtomicMarkers(await editorSnapshot(page), expectedMarkers, "case A protected Delete");
  const copiedMarkerText = await page.locator("#entry-content").evaluate((editor) => {
    const first = editor.querySelector("[data-photo-marker]");
    const selection = window.getSelection();
    const markerRange = document.createRange();
    markerRange.selectNode(first);
    selection.removeAllRanges();
    selection.addRange(markerRange);
    return selection.toString();
  });
  assert.equal(copiedMarkerText, expectedMarkers[0], "case A: copy selection exposes the compatible persisted marker");
  await page.keyboard.insertText("破壊");
  snapshot = await editorSnapshot(page);
  assert.deepEqual(markers(snapshot.text), expectedMarkers, "case A: selection replacement cannot change marker text");
  assert.deepEqual(snapshot.tokens.map((token) => token.marker), expectedMarkers, "case A: selection replacement keeps atomic tokens");
  await page.locator("#entry-content").evaluate((editor) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "貼り付け本文");
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  snapshot = await editorSnapshot(page);
  assertAtomicMarkers(snapshot, expectedMarkers, "case A paste");
  assert.ok(snapshot.text.endsWith("貼り付け本文"), "case A: paste appends all input text");
  await discardEditor(page);

  // B: use Chrome's composition pipeline rather than only dispatching synthetic composition events.
  await openEditor(page);
  await setEditor(page, "", [], 0);
  await dropPhotos(page, ["ime-one.png", "ime-two.png", "ime-three.png"]);
  snapshot = await editorSnapshot(page);
  expectedMarkers = markers(snapshot.text);
  await page.locator("#entry-content").evaluate((editor) => {
    window.__photoMarkerCompositionEvents = [];
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
      editor.addEventListener(type, (event) => window.__photoMarkerCompositionEvents.push(`${type}:${event.inputType || ""}`));
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
  await cdp.send("Input.imeSetComposition", { text: "日本語", selectionStart: 3, selectionEnd: 3 });
  await cdp.send("Input.insertText", { text: "日本語" });
  assertAtomicMarkers(await editorSnapshot(page), expectedMarkers, "case B IME commit");
  const compositionEvents = await page.evaluate(() => window.__photoMarkerCompositionEvents);
  assert.ok(compositionEvents.some((event) => event.startsWith("compositionstart:")), "case B: compositionstart observed");
  assert.ok(compositionEvents.some((event) => event.startsWith("compositionupdate:")), "case B: compositionupdate observed");
  assert.ok(compositionEvents.some((event) => event.startsWith("compositionend:")), "case B: compositionend observed");
  assert.ok(compositionEvents.some((event) => event.startsWith("beforeinput:insertCompositionText")), "case B: insertCompositionText observed");
  assert.ok(compositionEvents.some((event) => event.startsWith("input:")), "case B: input observed");
  await discardEditor(page);

  // C: content exists on both sides of the insertion point.
  await openEditor(page);
  await setEditor(page, "前の文章後の文章", [0], 4);
  await dropPhotos(page, ["middle-one.png", "middle-two.png", "middle-three.png"]);
  snapshot = await editorSnapshot(page);
  expectedMarkers = markers(snapshot.text);
  await insertOneCharacterAtATime(page, "追加文字", expectedMarkers, "case C");
  snapshot = await editorSnapshot(page);
  assert.ok(snapshot.text.startsWith("前の文章\n"), "case C: preceding text remains");
  assert.ok(snapshot.text.endsWith("追加文字後の文章"), "case C: following and appended text remain");
  await discardEditor(page);

  // D: rich-text runs remain around the atomic photo tokens.
  await openEditor(page);
  await setEditor(page,
    '<span class="diary-text-bold">太字</span><span class="diary-text-color-red">色</span><span class="diary-text-italic">斜体</span>',
    [], 1);
  await dropPhotos(page, ["rich-one.png", "rich-two.png", "rich-three.png"]);
  snapshot = await editorSnapshot(page);
  expectedMarkers = markers(snapshot.text);
  await insertOneCharacterAtATime(page, "追記", expectedMarkers, "case D");
  const richText = await page.locator("#entry-content").evaluate((editor) => ({
    bold: editor.querySelector(".diary-text-bold")?.textContent,
    red: editor.querySelector(".diary-text-color-red")?.textContent,
    italic: editor.querySelector(".diary-text-italic")?.textContent
  }));
  assert.equal(richText.bold, "太字", "case D: bold run remains");
  assert.ok(richText.red?.endsWith("色"), "case D: color run remains around its original text");
  assert.equal(richText.italic, "斜体", "case D: italic run remains");
  await discardEditor(page);

  // E: persist, reopen, and verify marker order, rich text, and photo ownership.
  await openEditor(page);
  await page.fill("#entry-title", "atomic marker draft");
  await setEditor(page, '<span class="diary-text-bold">保存前</span><span class="diary-text-italic">保存後</span>', [], 1);
  await dropPhotos(page, ["save-one.png", "save-two.png", "save-three.png"]);
  snapshot = await editorSnapshot(page);
  expectedMarkers = markers(snapshot.text);
  await insertOneCharacterAtATime(page, "再読込", expectedMarkers, "case E before save");
  await page.click("#save-draft-button");
  await page.waitForFunction(() => !document.querySelector("#editor-dialog")?.open);
  await page.waitForSelector("#entry-list [data-entry-id]");
  const savedEntry = [...persisted.entries.values()][0];
  assert.deepEqual(markers(savedEntry.content), expectedMarkers, "case E: persisted marker order");
  assert.equal(savedEntry.photos.length, 3, "case E: persisted photo count");
  assert.ok(savedEntry.photos.every((photo) => photo.entryId === savedEntry.id), "case E: photo owner relation");
  await page.click(`#entry-list [data-entry-id="${savedEntry.id}"]`);
  await page.waitForSelector("#editor-dialog[open]");
  snapshot = await editorSnapshot(page);
  assertAtomicMarkers(snapshot, expectedMarkers, "case E reopened");
  assert.ok(snapshot.text.includes("保存前"), "case E: preceding text persisted");
  assert.ok(snapshot.text.includes("再読込保存後"), "case E: following and appended text persisted");
  assert.equal(await page.locator("#entry-content .diary-text-bold").textContent(), "保存前", "case E: bold run persisted");
  assert.ok((await page.locator("#entry-content .diary-text-italic").textContent()).endsWith("保存後"), "case E: italic run persisted");

  process.stdout.write(`Diary photo marker atomicity passed in ${browserLabel}: multi-file drag/drop, per-character typing, IME, surrounding text, rich text, and draft reopen.\n`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
