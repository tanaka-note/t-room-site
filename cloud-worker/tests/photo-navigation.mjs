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
if (!script.includes("function renderPreviewImage(stage, file, url)") || !script.includes("stage.replaceChildren(image)") || script.includes("stage.append(image)")) {
  throw new Error("写真の復号案内を写真表示へ置き換える処理がありません。");
}

console.log("photo navigation and browser history: ok");
