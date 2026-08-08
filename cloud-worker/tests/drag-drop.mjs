import { readFile } from "node:fs/promises";

const [html, css, script] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8")
]);

if (!html.includes('id="drop-overlay"') || !css.includes(".drop-overlay")) {
  throw new Error("ドラッグ中の案内表示がありません。");
}
for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
  if (!script.includes(`addEventListener("${eventName}"`)) throw new Error(`${eventName} の処理がありません。`);
}
if (!script.includes("droppedDirectoryExists") || !script.includes("webkitGetAsEntry")) {
  throw new Error("フォルダのドロップを拒否する処理がありません。");
}
if (!script.includes("event.preventDefault()") || !script.includes("uploadFiles(files)")) {
  throw new Error("ブラウザ既定動作の防止または既存アップロード処理への接続がありません。");
}
if (!script.includes("state.uploading") || !script.includes("アップロードが完了してから")) {
  throw new Error("重複アップロード防止がありません。");
}
if (script.includes('matchMedia("(min-width: 901px)").matches')) {
  throw new Error("PCのウィンドウ幅によってドラッグ＆ドロップが無効になります。");
}
if (!script.includes('item.kind === "file"') || !script.includes("transfer.files?.length")) {
  throw new Error("Windowsブラウザごとのドラッグ情報の差を吸収できません。");
}
if (!html.includes('id="upload-file-progress"') || !script.includes("件完了") || !script.includes("保存処理中")) {
  throw new Error("複数ファイルの件数進捗がありません。");
}

console.log("desktop drag and drop upload: ok");
