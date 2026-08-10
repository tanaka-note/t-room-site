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

assert.doesNotMatch(mainHtml, /id="preview-fullscreen"/, "右上の全画面ボタンを表示しないでください。");
assert.doesNotMatch(shareHtml, /id="share-preview-fullscreen"/, "共有画面でも右上の全画面ボタンを表示しないでください。");
assert.doesNotMatch(mainHtml, /id="preview-rotate"/);
assert.doesNotMatch(shareHtml, /id="share-preview-rotate"/);
assert.match(mainHtml, /id="preview-more"/);
assert.doesNotMatch(mainJs, /togglePreviewFullscreen|preview-fullscreen/, "全画面操作は動画標準コントロールだけに統一してください。");
assert.doesNotMatch(shareJs, /toggleSharedPreviewFullscreen|share-preview-fullscreen/, "共有画面の全画面操作も動画標準コントロールだけに統一してください。");
assert.match(mainJs, /controlsList\.add\("nofullscreen"\)/);
assert.match(shareJs, /controlsList\.add\("nofullscreen"\)/);
assert.match(mainJs, /className = "preview-seekbar-fullscreen"/);
assert.match(shareJs, /className = "preview-seekbar-fullscreen"/);
assert.match(mainJs, /container\.requestFullscreen/);
assert.match(shareJs, /container\.requestFullscreen/);
assert.match(mainJs, /document\.exitFullscreen/);
assert.match(shareJs, /document\.exitFullscreen/);
assert.match(mainJs, /PREVIEW_FULLSCREEN_PORTRAIT_HOLD_MS = 600/);
assert.match(shareJs, /PREVIEW_FULLSCREEN_PORTRAIT_HOLD_MS = 600/);
assert.match(mainJs, /display-mode: standalone[\s\S]*?screen\.orientation\.lock\("portrait-primary"\)[\s\S]*?screen\.orientation\?\.unlock/);
assert.match(shareJs, /display-mode: standalone[\s\S]*?screen\.orientation\.lock\("portrait-primary"\)[\s\S]*?screen\.orientation\?\.unlock/);
assert.match(mainJs, /fullscreenchange[\s\S]*?handlePreviewFullscreenOrientationChange/);
assert.match(shareJs, /fullscreenchange[\s\S]*?handleSharedPreviewFullscreenOrientationChange/);
assert.match(mainJs, /webkitbeginfullscreen[^\n]*prepareInstalledVideoFullscreen/);
assert.match(shareJs, /webkitbeginfullscreen[^\n]*prepareInstalledVideoFullscreen/);
assert.match(mainJs, /video\.currentTime.*10/);
assert.match(shareJs, /video\.currentTime.*10/);
assert.match(mainCss, /width: min\(1280px/);
assert.match(shareCss, /width:min\(1280px/);
assert.match(mainCss, /\.player-buffering/);
assert.match(shareCss, /\.player-buffering/);
assert.match(mainCss, /\.preview-stage video \{ touch-action: pinch-zoom; \}/);
assert.match(shareCss, /\.preview-stage video \{ touch-action:pinch-zoom; \}/);
assert.match(mainCss, /height: 100dvh/);
assert.match(shareCss, /height:100dvh/);
assert.match(mainCss, /video:fullscreen[\s\S]*?height: 100dvh/, "動画標準の全画面表示で画面全体を使用してください。");
assert.match(shareCss, /video:fullscreen[\s\S]*?height:100dvh/, "共有動画も標準の全画面表示で画面全体を使用してください。");
assert.match(mainCss, /media-controls-fullscreen-button[^{]*\{ display: none !important; \}/);
assert.match(shareCss, /media-controls-fullscreen-button[^{]*\{ display:none !important; \}/);
assert.match(mainCss, /\.preview-seekbar-fullscreen/);
assert.match(shareCss, /\.preview-seekbar-fullscreen/);
assert.doesNotMatch(mainCss, /preview-rotate-overlay/);
assert.doesNotMatch(shareCss, /preview-rotate-overlay/);
assert.doesNotMatch(mainCss, /is-video-rotated|transform: rotate\(90deg\)/);
assert.doesNotMatch(shareCss, /is-video-rotated|transform:rotate\(90deg\)/);

console.log("shared sorting and immersive previews: ok");
