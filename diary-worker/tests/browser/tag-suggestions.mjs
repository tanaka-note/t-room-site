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
const tags = [
  { value: "最多", count: 100 },
  ...Array.from({ length: 24 }, (_, index) => ({
    value: `候補${String(index + 1).padStart(2, "0")}`,
    count: 80 - index
  })),
  { value: "同点10", count: 20 },
  { value: "同点2", count: 20 },
  { value: "ＡＬＰＨＡ", count: 12 },
  { value: "alphaBeta", count: 11 },
  { value: "ふゆ", count: 10 },
  { value: "末尾", count: 1 }
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (apiPath === "/session") return sendJson(response, {
      authenticated: true,
      role: "admin",
      accountName: "タグ候補テスト",
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
      months: [],
      tags
    });
    if (apiPath === "/entries") return sendJson(response, { entries: [], hasMore: false });
    return sendJson(response, {});
  }
  if (url.pathname === "/assets/pwa-auto-update.js") return sendFile(response, updaterPath);
  if (url.pathname === "/security/passkey-client.js") return sendFile(response, passkeyClientPath);

  const relativePath = url.pathname === "/diary/" ? "index.html" : url.pathname.replace(/^\/diary\//, "");
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

async function openEditor(page) {
  await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#app-view:not([hidden])");
  await page.click("#new-entry-button");
  await page.waitForSelector("#editor-dialog[open]");
}

async function suggestionValues(page) {
  return page.locator("#entry-tag-suggestions [data-tag]").evaluateAll((options) => options.map((option) => option.dataset.tag));
}

async function settleTagSuggestions(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function tagEditorGeometry(page) {
  return page.evaluate(() => {
    const editorDialog = document.querySelector("#editor-dialog");
    const entryTags = document.querySelector("#entry-tags");
    const suggestions = document.querySelector("#entry-tag-suggestions");
    const inputRect = entryTags.getBoundingClientRect();
    const suggestionRect = suggestions.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      scrollTop: editorDialog.scrollTop,
      scrollHeight: editorDialog.scrollHeight,
      inputTop: inputRect.top,
      suggestionTop: suggestionRect.top,
      suggestionBottom: suggestionRect.bottom,
      suggestionHidden: suggestions.hidden,
      suggestionPosition: getComputedStyle(suggestions).position,
      suggestionPlacement: suggestions.dataset.placement || "",
      viewportTop: viewport?.offsetTop || 0,
      viewportBottom: (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight)
    };
  });
}

function assertStableEditorGeometry(actual, expected, name, label) {
  assert.equal(actual.scrollHeight, expected.scrollHeight, `${name}: ${label}でもeditorのscrollHeightが変化しない`);
  assert.ok(Math.abs(actual.scrollTop - expected.scrollTop) <= 1, `${name}: ${label}でもeditorのscrollTopが変化しない`);
  assert.ok(Math.abs(actual.inputTop - expected.inputTop) <= 1, `${name}: ${label}でもタグ入力欄のY座標が変化しない`);
}

async function run(browserType, name, executablePath) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await openEditor(page);

    await page.locator("#editor-dialog").evaluate((dialog) => {
      dialog.scrollTop = dialog.scrollHeight;
    });
    await page.fill("#entry-tags", "alz");
    await settleTagSuggestions(page);
    const noMatchGeometry = await tagEditorGeometry(page);
    assert.equal(noMatchGeometry.suggestionHidden, true, `${name}: 0件では候補欄を閉じる`);

    await page.fill("#entry-tags", "a");
    await settleTagSuggestions(page);
    const englishMatchGeometry = await tagEditorGeometry(page);
    assertStableEditorGeometry(englishMatchGeometry, noMatchGeometry, name, "英字候補の表示");
    assert.equal(englishMatchGeometry.suggestionPosition, "fixed", `${name}: 候補欄をeditorのscrollable overflowから分離`);

    await page.fill("#entry-tags", "alz");
    await settleTagSuggestions(page);
    const englishNoMatchAgainGeometry = await tagEditorGeometry(page);
    assertStableEditorGeometry(englishNoMatchAgainGeometry, noMatchGeometry, name, "英字候補の再非表示");

    await page.fill("#entry-tags", "alpha");
    await settleTagSuggestions(page);
    const englishMatchAgainGeometry = await tagEditorGeometry(page);
    assertStableEditorGeometry(englishMatchAgainGeometry, noMatchGeometry, name, "英字候補の再表示");

    await page.fill("#entry-tags", "ふｙ");
    await settleTagSuggestions(page);
    const japaneseNoMatchGeometry = await tagEditorGeometry(page);
    assertStableEditorGeometry(japaneseNoMatchGeometry, noMatchGeometry, name, "日本語入力途中の候補非表示");

    await page.fill("#entry-tags", "ふゆ");
    await settleTagSuggestions(page);
    const japaneseMatchGeometry = await tagEditorGeometry(page);
    assertStableEditorGeometry(japaneseMatchGeometry, noMatchGeometry, name, "日本語候補の表示");
    assert.ok(japaneseMatchGeometry.suggestionTop >= japaneseMatchGeometry.viewportTop, `${name}: 候補欄は可視viewport上端からはみ出さない`);
    assert.ok(japaneseMatchGeometry.suggestionBottom <= japaneseMatchGeometry.viewportBottom, `${name}: 候補欄は可視viewport下端からはみ出さない`);

    await page.fill("#entry-tags", "alz");
    await page.locator("#editor-dialog").evaluate((dialog) => {
      dialog.scrollTop = Math.max(0, dialog.scrollHeight - dialog.clientHeight - 280);
    });
    await page.locator("#entry-tags").evaluate((input) => {
      input.value = "候補";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settleTagSuggestions(page);
    const aboveGeometry = await tagEditorGeometry(page);
    assert.equal(aboveGeometry.suggestionPlacement, "above", `${name}: 下側が狭いときは入力欄の上へ表示`);
    assert.ok(aboveGeometry.suggestionBottom <= aboveGeometry.inputTop, `${name}: 上側候補欄が入力欄へ重ならない`);
    assert.ok(aboveGeometry.suggestionTop >= aboveGeometry.viewportTop, `${name}: 上側候補欄も可視viewport内`);

    await page.locator("#editor-dialog").evaluate((dialog) => {
      dialog.scrollTop = dialog.scrollHeight;
    });
    await page.fill("#entry-tags", "");
    await page.focus("#entry-tags");
    const allValues = await suggestionValues(page);
    assert.equal(allValues.length, tags.length, `${name}: 未入力時に全タグを表示`);
    assert.equal(allValues[0], "最多", `${name}: 使用件数最多を先頭表示`);
    assert.ok(allValues.indexOf("同点2") < allValues.indexOf("同点10"), `${name}: 同数時は既存のnumeric collator順`);

    const scrollLayout = await page.locator("#entry-tag-suggestions").evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      maxHeight: getComputedStyle(element).maxHeight
    }));
    assert.ok(scrollLayout.clientHeight <= 246, `${name}: 候補欄は最大高以内`);
    assert.ok(scrollLayout.scrollHeight > scrollLayout.clientHeight, `${name}: 多数候補は内部スクロール`);
    assert.equal(scrollLayout.overflowY, "auto", `${name}: 縦スクロール有効`);
    assert.equal(scrollLayout.maxHeight, "246px", `${name}: 既存最大高を維持`);

    await page.fill("#entry-tags", "#alpha");
    assert.deepEqual(await suggestionValues(page), ["ＡＬＰＨＡ", "alphaBeta"], `${name}: NFKC・#除去・大文字小文字吸収の前方一致`);

    await page.fill("#entry-tags", "候補01、");
    const withoutSelected = await suggestionValues(page);
    assert.equal(withoutSelected.length, tags.length - 1, `${name}: 選択済みタグだけ除外`);
    assert.ok(!withoutSelected.includes("候補01"), `${name}: 選択済みタグを候補に含めない`);

    await page.fill("#entry-tags", "");
    await page.press("#entry-tags", "ArrowDown");
    for (let index = 0; index < 12; index += 1) await page.press("#entry-tags", "ArrowDown");
    const activeVisibility = await page.locator('#entry-tag-suggestions [aria-selected="true"]').evaluate((option) => {
      const container = option.parentElement;
      const optionRect = option.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return {
        tag: option.dataset.tag,
        scrollTop: container.scrollTop,
        visible: optionRect.top >= containerRect.top && optionRect.bottom <= containerRect.bottom
      };
    });
    assert.ok(activeVisibility.scrollTop > 0, `${name}: 6件超のキーボード移動で内部スクロール`);
    assert.equal(activeVisibility.visible, true, `${name}: アクティブ候補を表示範囲内へ追従`);
    await page.press("#entry-tags", "Enter");
    assert.equal(await page.inputValue("#entry-tags"), activeVisibility.tag, `${name}: Enterでアクティブ候補を選択`);
    assert.equal(await page.locator("#entry-tag-suggestions").isHidden(), true, `${name}: 選択後に候補を閉じる`);

    await page.fill("#entry-tags", "");
    await page.press("#entry-tags", "Escape");
    await page.focus("#entry-title");
    await page.focus("#entry-tags");
    const wrapValues = await suggestionValues(page);
    await page.press("#entry-tags", "ArrowDown");
    await page.press("#entry-tags", "ArrowUp");
    assert.equal(await page.locator('#entry-tag-suggestions [aria-selected="true"]').getAttribute("data-tag"), wrapValues.at(-1), `${name}: ArrowUpで末尾へ循環`);
    await page.press("#entry-tags", "Escape");
    assert.equal(await page.locator("#entry-tag-suggestions").isHidden(), true, `${name}: Escapeで候補を閉じる`);

    await page.fill("#entry-tags", "候補");
    await page.locator('#entry-tag-suggestions [data-tag="候補05"]').click();
    assert.equal(await page.inputValue("#entry-tags"), "候補05", `${name}: マウス・タッチ相当のクリック選択`);
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
  process.stdout.write("Diary tag suggestions passed in Chromium and Firefox.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
