import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, store, media, worker, css, server] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/offline-store.js", import.meta.url), "utf8"),
  readFile(new URL("../public/media-client.js", import.meta.url), "utf8"),
  readFile(new URL("../public/media-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.match(store, /CACHE_LIMIT_BYTES = 1024 \* 1024 \* 1024/);
assert.match(store, /OFFLINE_RETENTION_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
assert.match(store, /navigator\?\.storage\?\.getDirectory/);
assert.match(store, /entry\.offline/);
assert.match(store, /entry\.expiresAt/);
assert.match(store, /createWritable\(\{ keepExistingData: false \}\)/);

assert.match(client, /folderCount === 0/);
assert.match(client, /state\.selectedFolders\.size/);
assert.match(client, /files\.every\(\(file\) => !file\.trashed/);
assert.match(client, /rootWrappedFileKey/);
assert.match(client, /rootFileKeyIv/);
assert.match(client, /最上位フォルダを開き、PWを解除/);
assert.match(client, /TCloudOffline\.removeFile/);
assert.match(client, /file\.offlineOnly/);
assert.doesNotMatch(client, /saveOfflineFolder|offlineFolder/);

const selection = html.match(/<div class="selection-actions">([\s\S]*?)<\/div>/)?.[1] || "";
assert.ok(selection.indexOf('id="selection-offline"') > selection.indexOf('id="selection-delete"'), "オフライン操作は選択メニューの末尾に配置してください。");
assert.match(html, /id="offline-manager-dialog"/);
assert.match(html, /id="offline-panel"/);
assert.match(html, /id="offline-cancel"[^>]*>停止<\/button>/);
assert.match(html, /id="offline-progress"/);
assert.match(html, /id="offline-speed"/);
assert.match(html, /id="offline-eta"/);
assert.match(html, /id="offline-wake-lock-status"/);
assert.match(html, /offline-store\.js\?v=20260811-1/);
assert.match(css, /\.selection-actions[^}]*max-height:[^}]*overflow-y: auto/);
assert.match(css, /\.offline-button[^}]*background: #e7f2f0/);

assert.match(media, /saveOfflineFile/);
assert.match(client, /function createOfflineProgress\(files\)/);
assert.match(client, /保存済み部分は次回の再開に利用します/);
assert.match(client, /await syncTransferWakeLock\(\)/);
assert.match(media, /fetchEncryptedChunk/);
assert.match(worker, /TCloudOffline\.getChunk/);
assert.match(server, /\["\/offline-store\.js", "\/offline-store-20260811-1\.js"\]/);
assert.match(server, /deletedAt: file\.deleted_at/);

console.log("encrypted file-only cache and 30-day offline storage: ok");
