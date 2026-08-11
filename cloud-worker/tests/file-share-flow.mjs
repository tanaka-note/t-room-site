import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [mainHtml, mainClient, shareClient] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

assert.match(mainHtml, /id="selection-share"[^>]*>共有</);
assert.match(mainClient, /openShareDialog\("file", files\[0\]\)/);
assert.match(mainClient, /openShareDialog\("selection", files\)/);
assert.match(mainClient, /openShareDialog\("folder", folders\[0\]\)/);
assert.match(mainClient, /\(fileCount >= 1 && folderCount === 0\) \|\| \(folderCount === 1 && fileCount === 0\)/);
assert.match(mainClient, /TRoomCrypto\.wrapFileForShare/);
assert.match(shareClient, /directFile = file/);
assert.match(shareClient, /if \(directFile\) await openPreview\(directFile, \{ pushHistory: false \}\)/);
assert.match(shareClient, /data\.targetType === "selection"/);
assert.match(shareClient, /TRoomCrypto\.unlockFileFromShare/);

console.log("single and selected multi-file share flows: ok");
