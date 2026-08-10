import { readFile } from "node:fs/promises";

const [html, script, worker, share] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

if (!html.includes('id="edit-error"') || !script.includes('$("#edit-error").textContent = error.message')) {
  throw new Error("ファイル名変更エラーが編集画面内に表示されません。");
}
if (!script.includes("closePreviewForAction") || !script.includes("history.replaceState")) {
  throw new Error("ファイル名変更時のプレビュー履歴競合対策がありません。");
}
if (!script.includes('JSON.stringify({ name, passwordAction, ...passwordPackage })')) {
  throw new Error("フォルダ名の平文更新処理がありません。");
}
if (!script.includes("function canRenameFolder(folder)") || !script.includes("function canRenameFile(file)")) {
  throw new Error("解除済みフォルダ内の名称変更表示判定がありません。");
}
if (!html.includes('id="selection-rename"')
  || !script.includes('$("#selection-rename").addEventListener("click", openSelectedFileRenameDialog)')
  || !script.includes("fileCount === 1 && folderCount === 0 && canRenameFile(files[0])")) {
  throw new Error("長押しで1件選択したファイルの名前変更導線がありません。");
}
if (!script.includes("function canChangeFolderPassword(folder)") || !script.includes("const canEditPassword = canChangeFolderPassword(folder)")) {
  throw new Error("解除済み保護フォルダに限定したPW変更判定がありません。");
}
if (!script.includes("folder?.isProtected") || !script.includes("folder?.isUnlocked") || !script.includes("state.crypto.folderKeys.has(Number(folder.id))")) {
  throw new Error("副管理者のPW変更が保護・解除・鍵の3条件に限定されていません。");
}
if (!worker.includes("canRenameUnlockedItems: true") || !worker.includes("requireSameUnlockedMoveScope") || !worker.includes("副管理者はPWで解除した保護フォルダのPWだけ変更できます")) {
  throw new Error("副管理者の名称・PW変更と解除範囲内移動権限がサーバー側にありません。");
}
const loginStart = worker.indexOf("async function login(");
const loginEnd = worker.indexOf("async function getCryptoConfig(", loginStart);
const loginBody = worker.slice(loginStart, loginEnd);
if (!loginBody.includes("canRenameUnlockedItems: account.canRenameUnlockedItems")) {
  throw new Error("ログイン直後の副管理者セッションに、解除済み範囲の名称変更権限が反映されません。");
}
if (!worker.includes('UPDATE cloud_folders SET name = ?, updated_at = CURRENT_TIMESTAMP') || !worker.includes('name: folder.name')) {
  throw new Error("サーバーまたは共有画面の平文フォルダ名処理がありません。");
}
if (!share.includes("const folderName = folder.name") || !share.includes("name: child.name")) {
  throw new Error("共有画面が平文フォルダ名へ統一されていません。");
}

console.log("folder and file rename flows: ok");
