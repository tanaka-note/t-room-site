import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [mainHtml, mainCss, mainJs, shareHtml, shareCss, shareJs] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

for (const option of ["newest", "oldest", "name", "size"]) {
  assert.match(shareHtml, new RegExp(`value="${option}"`));
}
assert.match(shareHtml, /id="share-sort"/);
assert.match(shareJs, /function renderSortedItems\(\)/);
assert.match(shareJs, /state\.sort === "size"/);

assert.match(mainHtml, /id="preview-fullscreen"/);
assert.match(shareHtml, /id="share-preview-fullscreen"/);
assert.match(mainHtml, /id="preview-more"/);
assert.match(mainJs, /function togglePreviewFullscreen\(\)/);
assert.match(shareJs, /function toggleSharedPreviewFullscreen\(\)/);
assert.match(mainJs, /video\.currentTime.*10/);
assert.match(shareJs, /video\.currentTime.*10/);
assert.match(mainCss, /width: min\(1280px/);
assert.match(shareCss, /width:min\(1280px/);
assert.match(mainCss, /\.player-buffering/);
assert.match(shareCss, /\.player-buffering/);

console.log("shared sorting and immersive previews: ok");
