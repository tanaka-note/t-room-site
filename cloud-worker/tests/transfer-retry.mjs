import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [indexHtml, shareHtml, client, shareClient] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

assert.match(indexHtml, /id="upload-failure-summary"/);
assert.match(indexHtml, /id="download-failure-summary"/);
assert.match(shareHtml, /id="share-download-failure-summary"/);

assert.match(client, /const deferred = \[\];/);
assert.match(client, /deferred\.push\(\{ error, file, index \}\)/);
assert.match(client, /エラー分を再試行中/);
assert.match(client, /updateDownloadQueueItem\(file\.id, "後で再試行"/);
assert.match(client, /updateDownloadQueueItem\(file\.id, "再試行中"/);
assert.match(client, /renderTransferFailures\("#upload-failure-summary"/);
assert.match(client, /renderTransferFailures\("#download-failure-summary"/);
assert.match(client, /recordDownloadEvent\(activeFile\.id, "download_failed", "cancelled"\)/);
assert.doesNotMatch(client, /if \(!state\.uploadAbort\.signal\.aborted\) state\.uploadAbort\.abort\(\)/);

assert.match(shareClient, /エラーになったデータを最後に再試行しています/);
assert.match(shareClient, /async function downloadSharedFile/);
assert.match(shareClient, /renderSharedDownloadFailures\(deferred\)/);
assert.match(shareClient, /if \(error\.name === "AbortError"\) throw error/);
assert.match(shareClient, /recordEvent\(activeFile\.id, "download_failed", "cancelled"\)/);

console.log("upload and download deferred retry flows: ok");
