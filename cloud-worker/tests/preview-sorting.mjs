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

for (const key of ["updated", "name", "size"]) {
  assert.match(mainHtml, new RegExp(`data-sort-key="${key}"`));
  assert.match(shareHtml, new RegExp(`data-sort-key="${key}"`));
}
assert.match(shareHtml, /id="share-sort-controls"/);
assert.match(shareHtml, /id="share-display-toggle"[^>]*aria-label="横長表示へ切り替え"/);
assert.match(shareJs, /function renderSortedItems\(\)/);
assert.match(shareJs, /state\.sort === "size"/);
assert.match(shareJs, /function changeSharedSort\(key\)/);
assert.match(mainJs, /function changeSort\(key\)/);
assert.match(mainJs, /state\.sortDirection/);
assert.match(mainJs, /sort: "name",\s*sortDirection: "asc",\s*sortUsesTypeDefaults: true/);
assert.match(shareJs, /sort: "updated", sortDirection: "desc", sortUsesTypeDefaults: true/);
assert.match(shareJs, /listMode: false/);
assert.match(shareJs, /root\.classList\.toggle\("list-mode", state\.listMode\)/);
assert.match(shareJs, /state\.listMode = !state\.listMode/);
assert.match(shareCss, /\.folder \{ grid-column:1 \/ -1; \}/);
assert.match(shareCss, /\.items\.list-mode \{ grid-template-columns:1fr/);
assert.match(mainHtml, /class="sort-button active"[^>]*data-sort-key="name"[^>]*aria-pressed="true">名前 <span[^>]*>↑<\/span>/);
assert.match(shareHtml, /class="sort-button active"[^>]*data-sort-key="updated"[^>]*aria-pressed="true">更新日 <span[^>]*>↓<\/span>/);
assert.match(mainJs, /function resetTypeDefaultSort\(\)/);
assert.match(mainJs, /if \(state\.sortUsesTypeDefaults\) result\.sort\(\(a, b\) => a\.name\.localeCompare/);
assert.match(mainJs, /if \(state\.sortUsesTypeDefaults\) result\.sort\(\(a, b\) => String\(b\.updatedAt/);
assert.match(shareJs, /if \(state\.sortUsesTypeDefaults\) \{[\s\S]*?folders\.sort\(byName\);[\s\S]*?files\.sort/);

assert.match(mainHtml, /id="preview-fullscreen"/);
assert.match(shareHtml, /id="share-preview-fullscreen"/);
assert.match(mainHtml, /id="preview-rotate"[^>]*hidden/);
assert.match(shareHtml, /id="share-preview-rotate"[^>]*hidden/);
assert.match(mainHtml, /id="preview-more"/);
assert.match(mainJs, /function togglePreviewFullscreen\(\)/);
assert.match(shareJs, /function toggleSharedPreviewFullscreen\(\)/);
assert.match(mainJs, /function togglePreviewRotation\(\)/);
assert.match(shareJs, /function toggleSharedPreviewRotation\(\)/);
assert.match(mainJs, /screen\.orientation\.lock\("landscape"\)/);
assert.match(shareJs, /screen\.orientation\.lock\("landscape"\)/);
assert.match(mainJs, /resetPreviewRotation\(true\)/);
assert.match(shareJs, /resetSharedPreviewRotation\(\)/);
assert.match(mainJs, /video\.currentTime.*10/);
assert.match(shareJs, /video\.currentTime.*10/);
assert.match(mainCss, /width: min\(1280px/);
assert.match(shareCss, /width:min\(1280px/);
assert.match(mainCss, /\.player-buffering/);
assert.match(shareCss, /\.player-buffering/);
assert.match(mainCss, /\.preview-stage-wrap\.is-video-rotated[\s\S]*?transform: rotate\(90deg\)/);
assert.match(shareCss, /\.preview-stage\.is-video-rotated[\s\S]*?transform:rotate\(90deg\)/);

console.log("shared sorting and immersive previews: ok");
