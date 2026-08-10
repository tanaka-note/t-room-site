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
if (!script.includes('$("#folder-password-settings-row").hidden = !canEditPassword || inheritsProtection')) {
  throw new Error("副管理者のフォルダPW変更欄が非表示になっていません。");
}
if (!worker.includes("canRenameUnlockedItems: true") || !worker.includes("requireSameUnlockedMoveScope") || !worker.includes("フォルダPWを変更できるのは管理者だけです")) {
  throw new Error("副管理者の名称変更・解除範囲内移動権限がサーバー側にありません。");
}
if (!worker.includes('UPDATE cloud_folders SET name = ?, updated_at = CURRENT_TIMESTAMP') || !worker.includes('name: folder.name')) {
  throw new Error("サーバーまたは共有画面の平文フォルダ名処理がありません。");
}
if (!share.includes("const folderName = folder.name") || !share.includes("name: child.name")) {
  throw new Error("共有画面が平文フォルダ名へ統一されていません。");
}

console.log("folder and file rename flows: ok");
