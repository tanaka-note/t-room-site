import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [worker, client, html] = await Promise.all([
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8")
]);

assert.match(worker, /async function deleteFolder[\s\S]*?WITH RECURSIVE folder_tree[\s\S]*?UPDATE cloud_files[\s\S]*?UPDATE cloud_folders/);
assert.match(worker, /async function restoreFolder[\s\S]*?WITH RECURSIVE folder_tree[\s\S]*?folder_restored/);
assert.match(worker, /fo\.deleted_at IS NULL/);
assert.match(worker, /return json\(\{ files, folders \}\)/);
assert.match(worker, /WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 20/);
assert.match(client, /フォルダは中身ごとゴミ箱へ移動します/);
assert.match(client, /folders\.every\(canTrashFolder\)/);
assert.match(client, /const deletionQueue = \[[\s\S]*?folders\.map[\s\S]*?files\.map/);
assert.match(client, /state\.session\?\.canDelete \? confirm\(message\) : await confirmSubadminDeletion\(message\)/);
assert.match(client, /Math\.min\(4, deletionQueue\.length\)/);
assert.match(client, /task\.type === "folder" \? "folders" : "files"/);
assert.match(client, /削除中 \$\{processed\} \/ \$\{count\}/);
assert.match(client, /while \(remaining > 0 && failed === 0\)/);
assert.match(client, /trashFolderCard/);
assert.match(client, /closeOnSuccess[\s\S]*?download-dialog/);
assert.match(html, /id="trash-action-note"/);
assert.match(html, /id="delete-folder-button"[^>]*>削除</);

console.log("recursive folder trash and visible delete progress: ok");
