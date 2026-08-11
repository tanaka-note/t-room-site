import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, html, css, worker] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.match(html, /id="selection-move"/);
assert.match(html, /id="selection-delete"/);
assert.match(html, /id="move-dialog"/);
assert.match(client, /if \(!file\.trashed\) \{/);
assert.match(client, /function installFolderLongPressSelection/);
assert.doesNotMatch(client, /state\.selectedFiles\.size \|\| state\.selectedFolders\.size \? 80 : 380/);
assert.match(client, /function installLongPressSelection[\s\S]*?\}, 380\);[\s\S]*?setTimeout\(\(\) => \{ card\.dataset\.longPressed = "false"; \}, 0\)/);
assert.match(client, /function installFolderLongPressSelection[\s\S]*?\}, 380\);[\s\S]*?setTimeout\(\(\) => \{ card\.dataset\.longPressed = "false"; \}, 0\)/);
assert.match(client, /TRoomCrypto\.rewrapFileForFolder/);
assert.match(client, /TRoomCrypto\.rewrapFolderForParent/);
assert.match(client, /function canMoveFile/);
assert.match(client, /function canMoveFolder/);
assert.match(client, /function unlockedMoveScopeRoot/);
assert.match(client, /files\.every\(canMoveFile\) && folders\.every\(canMoveFolder\)/);
assert.match(client, /PWで解除した最上位フォルダの配下だけ移動できます/);
assert.match(client, /state\.crypto\.folderKeys\.get\(Number\(destination\.id\)\)/);
assert.match(client, /api\(`\/move-destinations/);
assert.match(client, /function buildMoveDestinations/);
assert.match(client, /async function loadMoveDestination/);
assert.doesNotMatch(client, /async function collectMoveDestinations/);
assert.match(worker, /\/api\/move-destinations/);
assert.match(worker, /async function listMoveDestinations/);
assert.match(worker, /WITH RECURSIVE folder_tree\(id, depth\)/);
assert.match(css, /\.folder-card \.folder-select-button/);
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

console.log("selection, bulk actions, and encrypted moves: ok");
