import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");

const helperStart = client.indexOf("function preserveListingAfterDeletion");
const helperEnd = client.indexOf("\nasync function startSelectedDownloads", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "削除後の表示維持処理が必要です");
const helper = client.slice(helperStart, helperEnd);
assert.match(helper, /state\.files = state\.files\.filter/);
assert.match(helper, /state\.folders = state\.folders\.filter/);
assert.match(helper, /syncSearchInputs\(\)/);
assert.match(helper, /window\.scrollTo\(\{ top: scrollY, left: scrollX, behavior: "auto" \}\)/);
assert.doesNotMatch(helper, /state\.query\s*=/);
assert.doesNotMatch(helper, /loadItems\(/);

for (const functionName of ["deleteSelectedFolder", "deleteSelectedItems", "deleteSelectedFile"]) {
  const start = client.indexOf(`async function ${functionName}`);
  const end = client.indexOf("\nasync function ", start + 1);
  assert.ok(start >= 0 && end > start, `${functionName} が必要です`);
  const body = client.slice(start, end);
  assert.match(body, /preserveListingAfterDeletion\(/, `${functionName} は検索結果をその場で更新します`);
  assert.doesNotMatch(body, /loadItems\(/, `${functionName} は削除後に画面全体を再読込しません`);
}

assert.match(client, /closePreviewForAction\(\);[\s\S]*?preserveListingAfterDeletion\(\{ files: \[file\] \}\)/);
assert.match(client, /if \(task\.type === "file"\) deletedFiles\.push\(task\.item\);[\s\S]*?else deletedFolders\.push\(task\.item\);/);

const context = vm.createContext({
  state: {
    query: "報告書",
    files: [{ id: 1, sizeBytes: 120 }, { id: 2, sizeBytes: 300 }],
    folders: [{ id: 3 }, { id: 4 }],
    itemLoadedFileIds: new Set([1, 2]),
    itemLoadedFolderIds: new Set([3, 4]),
    itemNextFileOffset: 12,
    itemNextFolderOffset: 8,
    folderSummary: { fileCount: 2, folderCount: 2, totalFileCount: 2, totalSizeBytes: 420 },
    selectedFiles: new Map(),
    selectedFolders: new Map(),
    selected: { id: 1 },
    selectedFolder: { id: 3 },
    itemPageParams: ""
  },
  window: {
    scrollX: 5,
    scrollY: 440,
    scrollTo(options) { this.restored = options; }
  },
  requestAnimationFrame(callback) { callback(); },
  clearSelectionWithoutRefresh() { throw new Error("選択なしでは呼ばれません"); },
  clearFileSelection() { context.selectionCleared = true; },
  renderItems() { context.rendered = true; },
  syncSearchInputs() { context.syncedQuery = context.state.query; },
  scheduleDisplayListingCacheWrite() {},
  displayListingCacheKey() { return ""; },
  URLSearchParams
});
vm.runInContext(helper, context);
vm.runInContext("preserveListingAfterDeletion({ files: [{ id: 1, sizeBytes: 120 }], folders: [{ id: 3 }] })", context);
assert.equal(context.state.query, "報告書");
assert.deepEqual(context.state.files.map((item) => item.id), [2]);
assert.deepEqual(context.state.folders.map((item) => item.id), [4]);
assert.equal(context.state.itemNextFileOffset, 11);
assert.equal(context.state.itemNextFolderOffset, 7);
assert.equal(context.state.folderSummary.totalSizeBytes, 300);
assert.equal(context.syncedQuery, "報告書");
assert.equal(context.window.restored.top, 440);
assert.equal(context.window.restored.left, 5);
assert.equal(context.window.restored.behavior, "auto");

console.log("search, sort and scroll remain stable after deletion: ok");
