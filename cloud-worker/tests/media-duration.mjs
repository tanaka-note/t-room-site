import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [main, share, mainHtml, shareHtml] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8")
]);

for (const client of [main, share]) {
  assert.match(client, /function normalizeDurationSeconds\(value\)/);
  assert.match(client, /function formatMediaDuration\(value\)/);
  assert.match(client, /function formatMediaDetails\(file\)/);
  assert.match(client, /class="file-size">\$\{formatMediaDetails\(file\)\}/);
  assert.match(client, /mediaKind[\s\S]*?durationSeconds/);
}

assert.match(main, /const durationPromise = readLocalMediaDuration\(file, mediaKind\)/);
assert.match(main, /fileMetadataForStorage\(file, mediaKind, durationSeconds\)/);
assert.match(main, /observeAndPersistMediaDuration\(video, file\)/);
assert.match(main, /observeAndPersistMediaDuration\(audio, file\)/);
assert.match(main, /TRoomCrypto\.encryptFileMetadata\(fileMetadataForStorage/);
assert.match(main, /file\.durationSeconds = normalizeDurationSeconds\(metadata\.durationSeconds\)/);
assert.match(main, /function scheduleMissingMediaDurations\(\)/);
assert.match(main, /new IntersectionObserver/);
assert.match(main, /function processDurationBackfillQueue\(\)/);
assert.match(main, /function readStoredMediaDuration\(file\)/);
assert.match(main, /readMediaDurationFromUrl\(media\.url, file\)/);
assert.match(main, /durationPending[\s\S]*?確認中/);
assert.match(main, /durationUnavailable[\s\S]*?時間不明/);
assert.match(main, /Promise\.allSettled\(\[[\s\S]*?captureVideoThumbnail[\s\S]*?readMediaDurationFromUrl/);
assert.match(share, /observeSharedMediaDuration\(video, file\)/);
assert.match(share, /observeSharedMediaDuration\(audio, file\)/);
assert.match(mainHtml, /cloud\.js\?v=20260810-107/);
assert.match(shareHtml, /share\.js\?v=20260810-33/);

console.log("encrypted media duration metadata and card display: ok");
