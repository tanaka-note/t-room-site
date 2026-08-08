import { readFile } from "node:fs/promises";

const [html, css, script] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8")
]);

for (const id of ["preview-prev", "preview-next", "preview-counter", "preview-stage-wrap"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`${id} がありません。`);
}
for (const marker of ["navigatePreview", "ArrowLeft", "ArrowRight", "touchstart", "touchend"]) {
  if (!script.includes(marker)) throw new Error(`写真移動処理 ${marker} がありません。`);
}
for (const marker of ["pushState", "popstate", "navigateToFolder", "handlePreviewClosed"]) {
  if (!script.includes(marker)) throw new Error(`戻る操作処理 ${marker} がありません。`);
}
if (!css.includes(".preview-nav") || !css.includes("touch-action: pan-y")) {
  throw new Error("写真移動UIのスタイルがありません。");
}

console.log("photo navigation and browser history: ok");
