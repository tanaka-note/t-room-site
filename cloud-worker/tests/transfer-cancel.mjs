import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, css, client] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8")
]);

assert.match(html, /id="upload-cancel"[^>]*>停止</);
assert.match(html, /id="download-cancel"[^>]*>停止</);
assert.match(css, /\.transfer-stop-button/);
assert.match(client, /uploadAbort: null/);
assert.match(client, /const fixedFolderId = state\.folderId \? Number\(state\.folderId\) : null/);
assert.match(client, /const fixedFolderKey = fixedFolderId \? state\.crypto\.folderKeys\.get\(fixedFolderId\) : null/);
assert.doesNotMatch(client, /destinationFolderId = state\.folderId/);
assert.match(client, /async function uploadOne\(file, index, total, destinationFolderId, destinationFolderKey, signal\)/);
assert.match(client, /rawBody: true, signal/);
assert.match(client, /function cancelUploads\(\)/);
assert.match(client, /state\.uploadAbort\.abort\(\)/);

console.log("upload/download stop and fixed upload destination: ok");
