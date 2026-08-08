import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, css, client] = await Promise.all([
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

assert.match(html, /id="share-selection-bar"/);
assert.match(html, /id="share-selection-download"[^>]*>まとめて保存</);
assert.match(html, /ZIPにまとめず/);
assert.match(css, /\.file \.file-select-button/);
assert.match(css, /\.file\.selected \.file-select-button::before \{ content:"✓"/);
assert.match(client, /selectedFiles: new Map\(\)/);
assert.match(client, /state\.targetType === "folder"/);
assert.match(client, /function toggleFileSelection/);
assert.match(client, /async function downloadFileSelection/);
assert.match(client, /TCloudMedia\.chooseDownloadDirectory\(\)/);
assert.match(client, /for \(const file of files\)/);
assert.doesNotMatch(client, /\.zip\b|application\/zip|JSZip/i);

console.log("shared folder multi-select downloads without ZIP: ok");
