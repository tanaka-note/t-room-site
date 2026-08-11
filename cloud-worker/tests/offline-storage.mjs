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

assert.match(store, /DEFAULT_CACHE_LIMIT_BYTES = 1024 \* 1024 \* 1024/);
assert.match(store, /MAX_CACHE_LIMIT_BYTES = 3 \* 1024 \* 1024 \* 1024/);
assert.match(store, /function setCacheLimitBytes\(value\)/);
assert.match(store, /Math\.min\(MAX_CACHE_LIMIT_BYTES, Math\.floor\(requested\)\)/);
assert.match(store, /if \(total <= cacheLimitBytes\) return/);
assert.match(store, /String\(entry\.accountScope\) === String\(accountScope\)/);
assert.match(store, /OFFLINE_RETENTION_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
assert.match(store, /navigator\?\.storage\?\.getDirectory/);
assert.match(store, /entry\.offline/);
assert.match(store, /entry\.expiresAt/);
assert.match(store, /createWritable\(\{ keepExistingData: false \}\)/);

assert.match(client, /folderCount === 0/);
assert.match(client, /state\.selectedFolders\.size/);
assert.match(client, /files\.every\(\(file\) => !file\.trashed/);
assert.match(client, /&& offlineSelectionContext\(files\)/);
assert.match(client, /function offlineSelectionContext\(files = \[\]\)/);
assert.match(client, /const protectedPathUnlocked = state\.breadcrumbs\.every/);
assert.match(client, /folder\.isUnlocked && state\.crypto\.folderKeys\.get\(Number\(folder\.id\)\) instanceof CryptoKey/);
assert.match(client, /Number\(file\.folderId\) !== currentFolderId/);
assert.match(client, /対象ファイルがあるフォルダのPWを解除してください/);
assert.match(client, /await showOfflineProgressInCurrentFolder\(\)/);
const offlineProgressFunction = client.match(/async function showOfflineProgressInCurrentFolder\(\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(offlineProgressFunction, /navigateToFolder/);
assert.match(client, /\$\("#offline-panel"\)\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
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
assert.match(html, /id="device-cache-limit"/);
assert.match(html, /value="3221225472">3GB<\/option>/);
assert.match(html, /id="offline-speed"/);
assert.match(html, /id="offline-eta"/);
assert.match(html, /id="offline-wake-lock-status"/);
assert.match(html, /offline-store\.js\?v=20260811-2/);
assert.match(css, /\.selection-actions[^}]*max-height:[^}]*overflow-y: auto/);
assert.match(css, /\.offline-button[^}]*background: #e7f2f0/);

assert.match(media, /saveOfflineFile/);
assert.match(client, /function createOfflineProgress\(files\)/);
assert.match(client, /保存済み部分は次回の再開に利用します/);
assert.match(client, /await syncTransferWakeLock\(\)/);
assert.match(client, /PLAYBACK_CACHE_LIMIT_OPTIONS = \[536870912, 1073741824, 2147483648, 3221225472\]/);
assert.match(client, /localStorage\.setItem\(playbackCacheLimitStorageKey\(\), String\(requested\)\)/);
assert.match(client, /TCloudOffline\.enforceCacheLimit\("", -1, context\.accountScope\)/);
assert.match(media, /fetchEncryptedChunk/);
assert.match(worker, /TCloudOffline\.getChunk/);
assert.match(media, /descriptor\.offlineOnly/);
assert.match(media, /if \(file\.offlineOnly\) throw new Error/);
assert.match(worker, /if \(file\.offlineOnly\) throw new Error/);
assert.match(worker, /DECRYPTED_CACHE_LIMIT_BYTES = 96 \* 1024 \* 1024/);
assert.match(worker, /DEMAND_PREFETCH_CHUNKS = 3/);
assert.match(worker, /warmMediaForPlayback\(data\.token, entry\)/);
assert.match(worker, /await loadEncryptedChunk\(entry, index\)/);
assert.match(worker, /cacheWriteChain/);
assert.match(worker, /shouldWarmTail\(descriptor\)/);
assert.match(worker, /isMp4Descriptor\(descriptor\)/);
assert.match(worker, /constrainOpenEndedMp4Range/);
assert.match(worker, /BACKGROUND_PREFETCH_DELAY_MS = 30_000/);
assert.match(worker, /MP4_METADATA_WARM_CHUNKS = 4/);
assert.match(worker, /MP4_RANGE_RESPONSE_LIMIT_BYTES = 2 \* 1024 \* 1024/);
assert.match(worker, /requested\.start \+ MP4_RANGE_RESPONSE_LIMIT_BYTES - 1/);
assert.doesNotMatch(worker, /MARK_MEDIA_READY|mediaReady|MP4_READY_RANGE_RESPONSE_LIMIT_BYTES/);
assert.match(worker, /if \(isMp4Descriptor\(descriptor\)\) await warmMp4Metadata\(entry\)/);
assert.match(worker, /SET_CACHE_LIMIT/);
assert.match(media, /cacheLimitBytes = Number\(global\.TCloudOffline/);
assert.match(media, /setCacheLimitBytes/);
assert.match(client, /const openLabel = \["video", "audio"\]\.includes\(item\.file\.mediaKind\) \? "オフライン再生" : "開く"/);
assert.match(client, /event\.target\.closest\("\.offline-manager-item"\)/);
assert.doesNotMatch(client, /entries = await syncOfflineSourceRecords\(entries, context\)/);
assert.match(server, /\["\/offline-store\.js", "\/offline-store-20260811-2\.js"\]/);
assert.match(server, /\["\/media-client\.js", "\/media-client-20260811-12\.js"\]/);
assert.match(server, /\["\/media-worker\.js", "\/media-worker-20260811-19\.js"\]/);
assert.match(server, /deletedAt: file\.deleted_at/);

console.log("encrypted file-only cache and 30-day offline storage: ok");
