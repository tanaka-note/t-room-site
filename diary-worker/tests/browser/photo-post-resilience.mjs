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
const photoIdPattern = /name="id"\r\n\r\n([0-9a-f-]{36})/i;

let scenario;
function resetScenario(mode) {
  scenario = {
    mode,
    nextEntryId: 100,
    entryRequests: [],
    entryGets: 0,
    finalPutAttempts: 0,
    entries: new Map(),
    createdEntryIds: new Set(),
    photoRequests: 0,
    storedPhotoIds: new Set(),
    uploadSessions: new Set(),
    commitRequests: [],
    committedSessions: new Set(),
    cancelRequests: [],
    photoUploadStartedBeforeEntry: false
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function savedEntry(id, body, revision = 1) {
  return {
    id,
    entryDate: body.entryDate,
    title: body.title,
    content: body.content,
    contentFormat: body.contentFormat || null,
    tags: body.tags || [],
    status: body.status || "published",
    photos: [],
    excludedPhotoIds: [],
    revision
  };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (apiPath === "/session") {
      sendJson(response, 200, {
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
      return;
    }
    if (apiPath === "/meta") {
      sendJson(response, 200, { draftCount: 0, months: [], tags: [] });
      return;
    }
    if (apiPath === "/entries" && request.method === "GET") {
      sendJson(response, 200, { entries: [], hasMore: false });
      return;
    }
    if (apiPath === "/entries" && request.method === "POST") {
      const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
      const id = scenario.nextEntryId++;
      scenario.createdEntryIds.add(id);
      scenario.entryRequests.push({ method: "POST", id, body });
      const entry = savedEntry(id, body);
      scenario.entries.set(id, entry);
      sendJson(response, 200, { entry });
      return;
    }
    if (apiPath === "/photo-upload-sessions" && request.method === "POST") {
      const id = crypto.randomUUID();
      scenario.uploadSessions.add(id);
      sendJson(response, 200, { uploadSession: { id, expiresAt: "2026-08-20T00:00:00.000Z" } });
      return;
    }
    const entryUpdateMatch = apiPath.match(/^\/entries\/(\d+)$/);
    if (entryUpdateMatch && request.method === "GET") {
      const id = Number(entryUpdateMatch[1]);
      scenario.entryGets += 1;
      const entry = scenario.entries.get(id);
      if (!entry) sendJson(response, 404, { error: "日記が見つかりません。" });
      else sendJson(response, 200, { entry });
      return;
    }
    if (entryUpdateMatch && request.method === "PUT") {
      const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
      const id = Number(entryUpdateMatch[1]);
      scenario.entryRequests.push({ method: "PUT", id, body });
      const current = scenario.entries.get(id);
      if (!current || Number(body.revision) !== Number(current.revision)) {
        sendJson(response, 409, { error: "別の端末で更新された可能性があります。再読み込みしてください。" });
        return;
      }
      const isFinalPhotoPut = /\[\[写真:[0-9a-f-]{36}\]\]/.test(body.content || "");
      if (isFinalPhotoPut) {
        scenario.finalPutAttempts += 1;
      }
      const entry = savedEntry(id, body, Number(body.revision || 1) + 1);
      scenario.entries.set(id, entry);
      sendJson(response, 200, { entry });
      return;
    }
    const photoUploadMatch = apiPath.match(/^\/photo-upload-sessions\/([0-9a-f-]{36})\/photos$/);
    if (photoUploadMatch && request.method === "POST") {
      const multipart = (await readRequestBody(request)).toString("latin1");
      const photoId = multipart.match(photoIdPattern)?.[1];
      assert.ok(photoId, "photo upload must contain a UUID");
      scenario.photoRequests += 1;
      if (scenario.entryRequests.length === 0) scenario.photoUploadStartedBeforeEntry = true;
      if (scenario.mode === "http-500-once" && scenario.photoRequests === 1) {
        sendJson(response, 503, { error: "一時的に画像を保存できません。" });
        return;
      }
      if (scenario.mode === "permanent-400") {
        sendJson(response, 400, { error: "画像形式を確認してください。" });
        return;
      }
      if (scenario.mode === "lost-response" && scenario.photoRequests === 1) {
        scenario.storedPhotoIds.add(photoId);
        request.socket.destroy();
        return;
      }
      const idempotent = scenario.storedPhotoIds.has(photoId);
      scenario.storedPhotoIds.add(photoId);
      sendJson(response, 200, {
        photo: {
          id: photoId,
          fileName: "test.png",
          contentType: "image/png",
          originalSize: validPng.length,
          width: 1,
          height: 1,
          createdByName: "テスト",
          createdAt: "2026-08-19 00:00:00",
          thumbnailUrl: `/diary/api/photos/${photoId}/thumbnail`,
          displayUrl: `/diary/api/photos/${photoId}/display`,
          originalUrl: `/diary/api/photos/${photoId}/original`
        },
        idempotent
      });
      return;
    }
    const photoCommitMatch = apiPath.match(/^\/photo-upload-sessions\/([0-9a-f-]{36})\/commit$/);
    if (photoCommitMatch && request.method === "POST") {
      const body = JSON.parse((await readRequestBody(request)).toString("utf8"));
      scenario.commitRequests.push(body);
      if (scenario.mode === "commit-500-once" && scenario.commitRequests.length === 1) {
        sendJson(response, 500, { error: "一時的に写真を反映できません。" });
        return;
      }
      if (scenario.mode === "commit-permanent-409") {
        sendJson(response, 409, { error: "写真を日記へ反映できませんでした。" });
        return;
      }
      const alreadyCommitted = scenario.committedSessions.has(photoCommitMatch[1]);
      scenario.committedSessions.add(photoCommitMatch[1]);
      if (scenario.mode === "commit-lost-response" && scenario.commitRequests.length === 1) {
        request.socket.destroy();
        return;
      }
      sendJson(response, 200, {
        photos: body.photoIds.map((photoId) => ({
          id: photoId,
          entryId: body.entryId,
          fileName: "test.png",
          contentType: "image/png",
          originalSize: validPng.length,
          width: 1,
          height: 1,
          createdByName: "テスト",
          createdAt: "2026-08-19T00:00:00.000Z",
          thumbnailUrl: `/diary/api/photos/${photoId}/thumbnail`,
          displayUrl: `/diary/api/photos/${photoId}/display`,
          originalUrl: `/diary/api/photos/${photoId}/original`
        })),
        idempotent: alreadyCommitted
      });
      return;
    }
    if (/^\/photo-upload-sessions\/[0-9a-f-]{36}(?:\/photos\/[0-9a-f-]{36})?$/.test(apiPath) && request.method === "DELETE") {
      scenario.cancelRequests.push(apiPath);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 200, {});
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

async function newDiaryPage(browser, contextOptions = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...contextOptions });
  await page.addInitScript(() => {
    const nativeCreateImageBitmap = window.createImageBitmap.bind(window);
    let releasePreparation = null;
    window.__holdPhotoPreparation = false;
    window.__photoPreparationWaiting = false;
    window.__startPhotoPreparationHold = () => { window.__holdPhotoPreparation = true; };
    window.__releasePhotoPreparation = () => {
      window.__holdPhotoPreparation = false;
      if (releasePreparation) releasePreparation();
      releasePreparation = null;
    };
    window.createImageBitmap = async (...args) => {
      if (window.__holdPhotoPreparation) {
        window.__photoPreparationWaiting = true;
        await new Promise((resolve) => { releasePreparation = resolve; });
        window.__photoPreparationWaiting = false;
      }
      return nativeCreateImageBitmap(...args);
    };
  });
  await page.goto(`${origin}/diary/`);
  await page.waitForSelector("#app-view:not([hidden])");
  await page.click("#new-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
  await page.fill("#entry-title", "写真付き投稿テスト");
  await page.evaluate(() => {
    const editor = document.querySelector("#entry-content");
    editor.textContent = "本文";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "本文" }));
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  return page;
}

async function choosePhoto(page, name = "test.png") {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#add-photo-button");
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: "image/png", buffer: validPng });
}

async function waitForEditorClosed(page) {
  await page.waitForFunction(() => !document.querySelector("#editor-dialog")?.open);
}

async function verifyPreparationRace(browser, name, contextOptions) {
  resetScenario("success");
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await page.evaluate(() => window.__startPhotoPreparationHold());
    await choosePhoto(page, "race.png");
    await page.waitForFunction(() => window.__photoPreparationWaiting === true);
    await page.click("#save-entry-button");
    await page.waitForTimeout(100);
    assert.equal(scenario.entryRequests.length, 0, `${name}: photo preparation must finish before entry serialization`);
    await page.evaluate(() => window.__releasePhotoPreparation());
    await page.waitForFunction(() => document.querySelector("#editor-photo-list .editor-photo-card"));
    await waitForEditorClosed(page);
    assert.deepEqual(scenario.entryRequests.map((item) => item.method), ["POST", "PUT"],
      `${name}: preparation race must create once and finalize its marker once`);
    assert.equal(scenario.photoRequests, 1, `${name}: prepared photo must upload once`);
    assert.equal(scenario.storedPhotoIds.size, 1, `${name}: prepared photo must be stored once`);
    assert.equal(scenario.photoUploadStartedBeforeEntry, true, `${name}: photo upload must start before the entry is posted`);
    assert.equal(scenario.commitRequests.length, 1, `${name}: staged photo must be committed once`);
    assert.doesNotMatch(scenario.entryRequests[0].body.content, /\[\[写真:/,
      `${name}: provisional entry must not persist an uncommitted marker`);
    const provisionalRuns = scenario.entryRequests[0].body.contentFormat?.runs || [];
    assert.ok(provisionalRuns.every((run) => run.start >= 0 && run.end <= scenario.entryRequests[0].body.content.length),
      `${name}: provisional contentFormat must remain within marker-free content`);
    assert.match(scenario.entryRequests[1].body.content, /本文\n\[\[写真:[0-9a-f-]{36}\]\]/,
      `${name}: finalized content must include the committed photo marker`);
    const runs = scenario.entryRequests[1].body.contentFormat?.runs || [];
    assert.ok(runs.every((run) => run.start >= 0 && run.end <= scenario.entryRequests[1].body.content.length),
      `${name}: contentFormat must remain within serialized content`);
  } finally {
    await page.close();
  }
}

async function verifyAutomaticRecovery(browser, name, mode, contextOptions) {
  resetScenario(mode);
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await choosePhoto(page, `${mode}.png`);
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    await page.waitForFunction(() => document.querySelector("#photo-preparation-status")?.textContent.includes("本文へ追加"));
    await page.click("#save-entry-button");
    await waitForEditorClosed(page);
    assert.deepEqual(scenario.entryRequests.map((item) => item.method), ["POST", "PUT"],
      `${name} ${mode}: entry must be created once and finalized in place`);
    assert.equal(scenario.createdEntryIds.size, 1, `${name} ${mode}: exactly one entry ID must be created`);
    assert.equal(scenario.photoRequests, 2, `${name} ${mode}: upload must retry exactly once before success`);
    assert.equal(scenario.storedPhotoIds.size, 1, `${name} ${mode}: retry must retain one logical photo`);
    assert.equal(scenario.photoUploadStartedBeforeEntry, true, `${name} ${mode}: retries must run while editing`);
    assert.equal(scenario.commitRequests.length, 1, `${name} ${mode}: posting must promote without another upload`);
  } finally {
    await page.close();
  }
}

async function verifyCommitFailureDiscard(browser, name, contextOptions) {
  resetScenario("commit-permanent-409");
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await choosePhoto(page, "commit-failure.png");
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    await page.click("#save-entry-button");
    await page.waitForFunction(() => document.querySelector("#editor-message")?.textContent.includes("写真を日記へ反映できませんでした。"));
    assert.equal(scenario.createdEntryIds.size, 1, `${name}: body save must create exactly one entry`);
    const entryId = [...scenario.createdEntryIds][0];
    assert.doesNotMatch(scenario.entries.get(entryId).content, /\[\[写真:/,
      `${name}: failed commit must never persist an orphan marker`);
    await page.click("#cancel-entry-button");
    await page.waitForSelector("#editor-leave-dialog[open]");
    await page.click("#editor-leave-discard");
    await waitForEditorClosed(page);
    assert.doesNotMatch(scenario.entries.get(entryId).content, /\[\[写真:/,
      `${name}: discard after commit failure must retain marker-free body`);
    assert.ok(scenario.cancelRequests.some((path) => /^\/photo-upload-sessions\/[0-9a-f-]{36}$/.test(path)),
      `${name}: discard after commit failure must cancel staging`);
  } finally {
    await page.close();
  }
}

async function verifyCommitRetry(browser, name, mode, contextOptions) {
  resetScenario(mode);
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await choosePhoto(page, `${mode}.png`);
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    await page.click("#save-entry-button");
    await page.waitForFunction(() => {
      const editor = document.querySelector("#editor-dialog");
      return !editor?.open || document.querySelector("#editor-message")?.textContent.includes("写真を保存できませんでした。");
    });
    const entryId = [...scenario.createdEntryIds][0];
    const editorOpen = await page.locator("#editor-dialog").evaluate((node) => node.open);
    if (!editorOpen) {
      assert.equal(mode, "commit-lost-response", `${name}: only a transport-level retry may finish without manual resubmission`);
      assert.equal(scenario.createdEntryIds.size, 1, `${name} ${mode}: transparent retry must not duplicate the entry`);
      assert.equal(scenario.commitRequests.length, 2, `${name} ${mode}: browser transport retry must remain idempotent`);
      assert.match(scenario.entries.get(entryId).content, /\[\[写真:[0-9a-f-]{36}\]\]/,
        `${name} ${mode}: transparent retry must finalize the marker`);
      return;
    }
    assert.doesNotMatch(scenario.entries.get(entryId).content, /\[\[写真:/,
      `${name} ${mode}: failed/lost commit response must leave a marker-free saved body`);
    if (mode === "commit-500-once") scenario.mode = "success";
    await page.click("#save-entry-button");
    await waitForEditorClosed(page);
    assert.equal(scenario.createdEntryIds.size, 1, `${name} ${mode}: retry must not duplicate the entry`);
    assert.deepEqual(scenario.entryRequests.map((item) => item.method), ["POST", "PUT", "PUT"],
      `${name} ${mode}: retry must update the provisional entry and then finalize it`);
    assert.equal(scenario.commitRequests.length, 2, `${name} ${mode}: commit must be retried once`);
    assert.match(scenario.entries.get(entryId).content, /\[\[写真:[0-9a-f-]{36}\]\]/,
      `${name} ${mode}: successful retry must persist the marker`);
  } finally {
    await page.close();
  }
}

async function verifyFinalPutRecovery(browser, name, mode, contextOptions) {
  resetScenario(mode);
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await page.evaluate((failureMode) => {
      const nativeFetch = window.fetch.bind(window);
      let injected = false;
      window.__finalPutFailureCount = 0;
      window.fetch = async (resource, init = {}) => {
        const url = new URL(typeof resource === "string" ? resource : resource.url, window.location.href);
        const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
        const isFinalPhotoPut = init.method === "PUT"
          && /^\/diary\/api\/entries\/\d+$/.test(url.pathname)
          && /\[\[写真:[0-9a-f-]{36}\]\]/.test(body?.content || "");
        if (!injected && isFinalPhotoPut) {
          injected = true;
          window.__finalPutFailureCount += 1;
          if (failureMode === "final-put-lost-response") await nativeFetch(resource, init);
          throw new TypeError("simulated final PUT transport failure");
        }
        return nativeFetch(resource, init);
      };
    }, mode);
    await choosePhoto(page, `${mode}.png`);
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    await page.click("#save-entry-button");
    try {
      await waitForEditorClosed(page);
    } catch (error) {
      const message = await page.locator("#editor-message").textContent();
      throw new Error(`${name} ${mode}: editor did not close (${message}); ${JSON.stringify({
        entryGets: scenario.entryGets,
        finalPutAttempts: scenario.finalPutAttempts,
        entryRequests: scenario.entryRequests
      })}`, { cause: error });
    }

    assert.equal(scenario.createdEntryIds.size, 1, `${name} ${mode}: reconciliation must not create another entry`);
    assert.equal(scenario.commitRequests.length, 1, `${name} ${mode}: reconciliation must not commit the photo twice`);
    assert.ok(scenario.entryGets >= 1, `${name} ${mode}: an ambiguous final PUT must re-read the entry`);
    assert.equal(scenario.finalPutAttempts, 1, `${name} ${mode}: the server must apply the marker exactly once`);
    assert.equal(await page.evaluate(() => window.__finalPutFailureCount), 1,
      `${name} ${mode}: the response-loss boundary must be injected exactly once`);
    const entryId = [...scenario.createdEntryIds][0];
    const entry = scenario.entries.get(entryId);
    assert.equal((entry.content.match(/\[\[写真:[0-9a-f-]{36}\]\]/g) || []).length, 1,
      `${name} ${mode}: the committed marker must exist exactly once`);
    assert.equal(Number(await page.inputValue("#entry-revision")), entry.revision,
      `${name} ${mode}: the client revision must match the reconciled server revision`);
    assert.equal(scenario.entryRequests.filter((item) => item.method === "POST").length, 1,
      `${name} ${mode}: recovery must retain the original entry ID`);
  } finally {
    await page.close();
  }
}

async function verifyPermanentFailure(browser, name, contextOptions) {
  resetScenario("permanent-400");
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await choosePhoto(page, "permanent.png");
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    await page.click("#save-entry-button");
    await page.waitForFunction(() => document.querySelector("#editor-message")?.textContent.includes("画像形式を確認してください。"));
    assert.equal(scenario.photoRequests, 2, `${name}: background failure must be retried once when posting`);
    assert.equal(scenario.createdEntryIds.size, 0, `${name}: entry must not be created before required photos are ready`);
    assert.equal(await page.locator("#editor-dialog").evaluate((node) => node.open), true, `${name}: editor must remain open after photo failure`);
    assert.equal(await page.inputValue("#entry-id"), "", `${name}: failed preupload must not create a partial entry`);

    scenario.mode = "success";
    await page.click("#save-entry-button");
    await waitForEditorClosed(page);
    assert.deepEqual(scenario.entryRequests.map((item) => item.method), ["POST", "PUT"],
      `${name}: retry after preupload recovery must create once and finalize the marker in place`);
    assert.equal(scenario.createdEntryIds.size, 1, `${name}: manual resubmission must not create another entry`);
    assert.equal(scenario.storedPhotoIds.size, 1, `${name}: recovered photo must be stored once`);
  } finally {
    await page.close();
  }
}

async function verifyDiscardCleanup(browser, name, contextOptions) {
  resetScenario("success");
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await choosePhoto(page, "discard.png");
    await page.waitForFunction(() => window.document.querySelector("#editor-photo-list .editor-photo-card") && window.document.querySelector("#photo-preparation-status")?.textContent.includes("本文へ追加"));
    await page.waitForFunction(() => window.document.querySelector("#editor-message")?.textContent !== "写真の保存完了を待っています...");
    await page.waitForTimeout(100);
    await page.click("#cancel-entry-button");
    await page.waitForSelector("#editor-leave-dialog[open]");
    await page.click("#editor-leave-discard");
    await waitForEditorClosed(page);
    assert.equal(scenario.entryRequests.length, 0, `${name}: discarding must not create an entry`);
    assert.ok(scenario.cancelRequests.some((path) => /^\/photo-upload-sessions\/[0-9a-f-]{36}$/.test(path)),
      `${name}: discarding must cancel the staging session`);
  } finally {
    await page.close();
  }
}

async function verifyNewDraft(browser, name, contextOptions) {
  resetScenario("success");
  const page = await newDiaryPage(browser, contextOptions);
  try {
    await choosePhoto(page, "draft.png");
    await page.waitForSelector("#editor-photo-list .editor-photo-card");
    await page.click("#save-draft-button");
    await waitForEditorClosed(page);
    assert.deepEqual(scenario.entryRequests.map((item) => item.method), ["POST", "PUT"],
      `${name}: a photo draft must save provisionally and finalize in place`);
    assert.ok(scenario.entryRequests.every((item) => item.body.status === "draft"),
      `${name}: both provisional and final saves must remain drafts`);
    const entryId = [...scenario.createdEntryIds][0];
    assert.match(scenario.entries.get(entryId).content, /\[\[写真:[0-9a-f-]{36}\]\]/,
      `${name}: a successfully committed draft must contain its marker`);
  } finally {
    await page.close();
  }
}

async function runBrowser(browserType, name, executablePath, contextOptions = {}) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    await verifyPreparationRace(browser, name, contextOptions);
    await verifyAutomaticRecovery(browser, name, "http-500-once", contextOptions);
    await verifyAutomaticRecovery(browser, name, "lost-response", contextOptions);
    await verifyPermanentFailure(browser, name, contextOptions);
    await verifyDiscardCleanup(browser, name, contextOptions);
    await verifyNewDraft(browser, name, contextOptions);
    await verifyCommitFailureDiscard(browser, name, contextOptions);
    await verifyCommitRetry(browser, name, "commit-500-once", contextOptions);
    await verifyCommitRetry(browser, name, "commit-lost-response", contextOptions);
    await verifyFinalPutRecovery(browser, name, "final-put-lost-response", contextOptions);
    await verifyFinalPutRecovery(browser, name, "final-put-unapplied", contextOptions);
  } finally {
    await browser.close();
  }
}

try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await runBrowser(chromium, "Chromium", chromiumPath);
  await runBrowser(firefox, "Firefox", firefoxPath);
  await runBrowser(chromium, "Touch", chromiumPath, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  process.stdout.write("Photo post preparation, transient retry, lost-response recovery, and permanent failure recovery passed in Chromium, Firefox, and touch emulation.\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
