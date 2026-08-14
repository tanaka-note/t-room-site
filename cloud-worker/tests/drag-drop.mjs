import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
if (!script.includes("getAsFileSystemHandle") || !script.includes("webkitGetAsEntry") || !script.includes("collectDroppedHandle") || !script.includes("collectDroppedContent")) {
  throw new Error("新旧ブラウザ両方のフォルダ読み取り処理がありません。");
}
if (!script.includes("event.preventDefault()") || !script.includes("uploadFiles(dropped.looseFiles)")) {
  throw new Error("ブラウザ既定動作の防止または既存アップロード処理への接続がありません。");
}
const dropHandler = script.match(/async function handleFileDrop\(event\) \{[\s\S]*?\n\}/)?.[0] || "";
const uploadCallIndex = dropHandler.indexOf("uploadFiles(dropped.looseFiles)");
const revealCallIndex = dropHandler.indexOf("revealDroppedUploadProgress()");
if (uploadCallIndex < 0 || revealCallIndex <= uploadCallIndex) {
  throw new Error("PCのドロップアップロード開始後に進捗欄へ移動する処理がありません。");
}
const fileInputHandler = script.match(/\$\("#file-input"\)\.addEventListener\("change",[^\n]+/)?.[0] || "";
if (fileInputHandler.includes("revealDroppedUploadProgress")) {
  throw new Error("ファイル選択ボタンのアップロードへドロップ専用の移動処理が混入しています。");
}
const revealHelper = script.match(/function revealDroppedUploadProgress\(\) \{[\s\S]*?\n\}/)?.[0] || "";
if (!revealHelper.includes('$("#upload-panel")') || !revealHelper.includes("requestAnimationFrame") || !revealHelper.includes("scrollIntoView")) {
  throw new Error("既存のアップロード進捗欄を描画後に表示する処理が不完全です。");
}
const scrollCalls = [];
const panel = {
  hidden: false,
  scrollIntoView(options) { scrollCalls.push(options); }
};
const context = {
  $: (selector) => selector === "#upload-panel" ? panel : null,
  window: { requestAnimationFrame(callback) { callback(); } }
};
vm.runInNewContext(`${revealHelper}; revealDroppedUploadProgress();`, context);
if (scrollCalls.length !== 1 || scrollCalls[0]?.behavior !== "smooth" || scrollCalls[0]?.block !== "start") {
  throw new Error("ドロップ後にアップロード進捗欄の先頭へ移動できません。");
}
panel.hidden = true;
vm.runInNewContext(`${revealHelper}; revealDroppedUploadProgress();`, context);
if (scrollCalls.length !== 1) {
  throw new Error("進捗欄が非表示のときにも不要な画面移動が発生します。");
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
if (!html.includes('id="upload-file-progress"') || !script.includes("件完了") || !script.includes("Cloudflareで保存を確定中")) {
  throw new Error("複数ファイルの件数進捗がありません。");
}

console.log("desktop drag and drop upload: ok");
