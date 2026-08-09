import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, worker] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.doesNotMatch(html, /data-view="requests"/);
assert.doesNotMatch(html, /id="request-delete-file-button"/);
assert.match(html, /id="delete-confirm-dialog"/);
assert.match(html, /value="no">いいえ/);
assert.match(html, /value="yes">はい/);
assert.match(html, /id="storage-meter"[^>]*hidden/);
assert.match(html, /id="trash-usage-text"/);
assert.match(html, /class="top-actions"[\s\S]*id="logout-button"/);
assert.doesNotMatch(html, /id="mobile-logout-button"/);
assert.match(client, /function confirmSubadminDeletion/);
assert.match(client, /setNotice\(state\.session\?\.canDelete \? "ゴミ箱へ移動しました。" : "削除しました。"\)/);
assert.match(client, /state\.session\?\.role !== "admin"/);
assert.match(worker, /canTrashUnlockedFiles: true/);
assert.match(worker, /PWで解除したフォルダ内のファイルだけ削除できます/);
assert.doesNotMatch(worker, /purgeExpiredTrash\(env\)/);

console.log("subadmin soft delete and admin-only trash usage: ok");
