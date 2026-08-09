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
assert.match(css, /\.folder-card \.folder-select-button/);
assert.match(css, /\.file-card\.selected \.file-select-button, \.folder-card\.selected \.folder-select-button/);
assert.doesNotMatch(css, /\.content-grid\.list-mode \.file-select-button \{ display: none; \}/);
assert.match(client, /selectButton\.className = "folder-select-button"/);
assert.match(client, /card\.querySelector\("\.folder-select-button"\)\?\.setAttribute\("aria-pressed", "true"\)/);
assert.match(worker, /ensureValidFolderMove\(env, id, parentId\)/);
assert.match(worker, /folder_id = \?, wrapped_file_key = \?, file_key_iv = \?/);

console.log("selection, bulk actions, and encrypted moves: ok");
