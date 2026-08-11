import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, html, css, worker] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.match(html, /id="selection-move"/);
assert.match(html, /id="selection-delete"/);
assert.match(html, /id="selection-share"/);
assert.ok(html.indexOf('id="selection-share"') < html.indexOf('id="selection-rename"'), "共有は長押し直後に見える位置へ配置してください。");
assert.match(html, /id="move-dialog"/);
assert.match(html, /id="move-picker-up"/);
assert.match(html, /id="move-breadcrumbs"/);
assert.match(html, /id="move-folder-list"/);
assert.match(html, /id="move-current-location"/);
assert.doesNotMatch(html, /<select id="move-destination"/);
assert.match(client, /if \(!file\.trashed\) \{/);
assert.match(client, /function installFolderLongPressSelection/);
assert.doesNotMatch(client, /state\.selectedFiles\.size \|\| state\.selectedFolders\.size \? 80 : 380/);
assert.match(client, /function installLongPressSelection[\s\S]*?\}, 380\);[\s\S]*?setTimeout\(\(\) => \{ card\.dataset\.longPressed = "false"; \}, 0\)/);
assert.match(client, /const LONG_PRESS_DRAG_THRESHOLD_PX = 28/);
assert.match(client, /const distance = Math\.hypot\(event\.clientX - startX, event\.clientY - startY\)/);
assert.match(client, /if \(!dragSelectionActive && distance < LONG_PRESS_DRAG_THRESHOLD_PX\) return/);
assert.match(client, /dragSelectionActive = true;[\s\S]*?state\.selecting = true/);
assert.match(client, /function installFolderLongPressSelection[\s\S]*?\}, 380\);[\s\S]*?setTimeout\(\(\) => \{ card\.dataset\.longPressed = "false"; \}, 0\)/);
assert.match(client, /TRoomCrypto\.rewrapFileForFolder/);
assert.match(client, /TRoomCrypto\.rewrapFolderForParent/);
assert.match(client, /function canMoveFile/);
assert.match(client, /function canMoveFolder/);
assert.match(client, /function unlockedMoveScopeRoot/);
assert.match(client, /files\.every\(canMoveFile\) && folders\.every\(canMoveFolder\)/);
assert.match(client, /PWで解除した最上位フォルダの配下だけ移動できます/);
assert.match(client, /state\.crypto\.folderKeys\.get\(Number\(destination\.id\)\)/);
assert.match(client, /const canShareSelection = \(fileCount >= 1 && folderCount === 0 && files\.every\(canShareFile\)\)/);
assert.match(client, /api\(`\/move-destinations/);
assert.match(client, /function buildMovePicker/);
assert.match(client, /function renderMovePicker/);
assert.match(client, /function openMovePickerFolder/);
assert.match(client, /function movePickerUp/);
assert.doesNotMatch(client, /button\.setAttribute\("role", "listitem"\)/);
assert.match(client, /selectedFolderIds\.has\(Number\(current\.id\)\)/);
assert.match(client, /movePickerCurrentIsSource/);
assert.match(client, /submit\.textContent = sameLocation \? "現在の場所です" : "ここへ移動"/);
assert.match(client, /async function loadMoveDestination/);
assert.doesNotMatch(client, /async function collectMoveDestinations/);
assert.match(worker, /\/api\/move-destinations/);
assert.match(worker, /async function listMoveDestinations/);
assert.match(worker, /WITH RECURSIVE folder_tree\(id, depth\)/);
assert.match(css, /\.folder-card \.folder-select-button/);
assert.match(css, /\.move-folder-list/);
assert.match(css, /\.move-folder-button/);
assert.match(css, /\.move-breadcrumbs/);
assert.match(css, /\.file-card\.selected \.file-select-button, \.folder-card\.selected \.folder-select-button/);
assert.doesNotMatch(css, /\.content-grid\.list-mode \.file-select-button \{ display: none; \}/);
assert.match(client, /selectButton\.className = "folder-select-button"/);
assert.match(client, /card\.querySelector\("\.folder-select-button"\)\?\.setAttribute\("aria-pressed", "true"\)/);
assert.match(worker, /ensureValidFolderMove\(env, id, parentId\)/);
assert.match(worker, /folder_id = \?, wrapped_file_key = \?, file_key_iv = \?/);
assert.match(worker, /async function requireSameUnlockedMoveScope/);
assert.match(worker, /const sourceScope = await unlockedMoveScopeId/);
assert.match(worker, /const destinationScope = await unlockedMoveScopeId/);
assert.match(worker, /sameUnlockedMoveScope|requireSameUnlockedMoveScope/);
assert.doesNotMatch(worker, /副管理者はファイルを移動できません/);
assert.doesNotMatch(worker, /副管理者はフォルダを移動できません/);

const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  navigator: {},
  innerHeight: 800,
  scrollBy() {},
  document: { addEventListener() {}, elementFromPoint() { return null; } },
  TCloudMedia: {}
});
vm.runInContext(client, context);
context.movePickerRecords = [
  { id: 1, parentId: null, name: "Atsushi" },
  { id: 2, parentId: null, name: "Masami" },
  { id: 3, parentId: 1, name: "動画" },
  { id: 4, parentId: 3, name: "2026" },
  { id: 5, parentId: 1, name: "移動対象" },
  { id: 6, parentId: 5, name: "移動対象の配下" }
];
const pickerSummary = vm.runInContext(`(() => {
  const picker = buildMovePicker(
    movePickerRecords,
    null,
    new Set([5]),
    [{ id: 100, folderId: 3, name: "sample.mp4" }],
    [{ id: 5, parentId: 1, name: "移動対象", isProtected: true }]
  );
  const rootNames = (picker.children.get(null) || []).map((folder) => folder.name);
  const atsushiChildren = (picker.children.get(1) || []).map((folder) => folder.name);
  picker.currentId = 4;
  const pathNames = movePickerPath(picker).map((folder) => folder.name);
  picker.currentId = 3;
  const sameSource = movePickerCurrentIsSource(picker);
  return { rootNames, atsushiChildren, pathNames, sameSource, excludedTarget: !picker.byId.has(5), excludedChild: !picker.byId.has(6) };
})()`, context);
assert.deepEqual([...pickerSummary.rootNames], ["Atsushi", "Masami"]);
assert.deepEqual([...pickerSummary.atsushiChildren], ["動画"]);
assert.deepEqual([...pickerSummary.pathNames], ["Atsushi", "動画", "2026"]);
assert.equal(pickerSummary.sameSource, false, "複数の移動元が混在する場合は現在地扱いにしません。");
assert.equal(pickerSummary.excludedTarget, true);
assert.equal(pickerSummary.excludedChild, true);

const subadminSummary = vm.runInContext(`(() => {
  const picker = buildMovePicker(movePickerRecords.slice(0, 4), { id: 1, name: "Atsushi" }, new Set(), [{ folderId: 3 }], []);
  return {
    currentId: picker.currentId,
    rootName: picker.byId.get(picker.scopeRootId).name,
    children: (picker.children.get(1) || []).map((folder) => folder.name)
  };
})()`, context);
assert.equal(subadminSummary.currentId, 1);
assert.equal(subadminSummary.rootName, "Atsushi");
assert.deepEqual([...subadminSummary.children], ["動画"]);

const longPressResult = await vm.runInContext(`(async () => {
  const listeners = new Map();
  const makeCard = (id) => ({
    dataset: { fileId: String(id) },
    classList: { add() {}, remove() {} },
    querySelector() { return null; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    closest(selector) { return selector === ".file-card" ? this : null; }
  });
  const firstCard = makeCard(201);
  const secondCard = makeCard(202);
  const firstFile = { id: 201, name: "first.mp4" };
  const secondFile = { id: 202, name: "second.mp4" };
  state.files = [firstFile, secondFile];
  state.selectedFiles.clear();
  state.selectedFolders.clear();
  syncSelectionBar = () => {};
  document.elementFromPoint = () => secondCard;
  installLongPressSelection(firstCard, firstFile);
  listeners.get("pointerdown")({ pointerType: "touch", button: 0, pointerId: 9, clientX: 10, clientY: 10 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterLongPress = state.selectedFiles.size;
  listeners.get("pointermove")({ pointerId: 9, clientX: 16, clientY: 10, preventDefault() {} });
  const afterFingerJitter = state.selectedFiles.size;
  listeners.get("pointermove")({ pointerId: 9, clientX: 45, clientY: 10, preventDefault() {} });
  const afterDeliberateDrag = state.selectedFiles.size;
  listeners.get("pointerup")({ pointerId: 9, preventDefault() {} });
  return { afterLongPress, afterFingerJitter, afterDeliberateDrag };
})()`, context);
assert.deepEqual({ ...longPressResult }, { afterLongPress: 1, afterFingerJitter: 1, afterDeliberateDrag: 2 });

console.log("selection, bulk actions, and encrypted moves: ok");
