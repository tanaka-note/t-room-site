import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

if (!worker.includes("normalizeEncryptedFolder(body, false)")) throw new Error("フォルダPWが任意になっていません。");
if (!worker.includes("const passwordHash = encrypted.authProof ? await hashPassword(encrypted.authProof) : null")) throw new Error("配下フォルダのPW継承処理がありません。");
if (!worker.includes('if (!parentId && !body.authProof) throw new HttpError(400, "最上位フォルダにはパスワードが必要です。")')) throw new Error("最上位フォルダのPW必須制御がありません。");
if (!worker.includes("requireFolderEdit(session)")) throw new Error("PW再設定の管理者権限確認がありません。");
if (!worker.includes("個別PWがない配下フォルダでは、作成後にPWを追加できません")) throw new Error("個別PWなしフォルダの制約がありません。");
if (!client.includes('const password = $("#folder-password-enabled").checked ? $("#folder-password").value : ""')) throw new Error("新規フォルダのPW選択処理がありません。");
if (!client.includes("await planFolderUpload(selection, baseParentId, baseParentKey, operationId)")) throw new Error("フォルダアップロードの事前差分確認がありません。");
if (!client.includes('const folderPassword = !baseParentId && !folderPlan.parentPath ? topLevelPassword : ""')) throw new Error("最上位フォルダアップロードの共通PW設定がありません。");
if (!client.includes("createEncryptedFolder(folderPlan.name, inheritedParent.id, inheritedParent.key, folderPassword)")) throw new Error("フォルダアップロードの階層別PW設定がありません。");
if (!client.includes("TRoomCrypto.unlockFolderFromParent(folder, parentKey)")) throw new Error("親フォルダ鍵による自動解除がありません。");
for (const id of ["folder-password-enabled", "folder-password-row", "folder-password-settings-row", "folder-inherited-settings-note", "folder-upload-password-row", "folder-upload-password"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`${id} がありません。`);
}
if (html.includes('id="folder-inherit-note"') || html.includes('id="folder-upload-inherit-note"')) throw new Error("不要な保護継承文言が残っています。");
if (!html.includes('id="folder-password-row" hidden')) throw new Error("PW入力欄が初期状態で非表示ではありません。");
if (!client.includes('$("#folder-password-enabled").disabled = topLevelFolder')) throw new Error("最上位のPWチェックを解除不能にしていません。");
if (!client.includes('$("#folder-upload-password").required = topLevelUpload')) throw new Error("最上位フォルダアップロードのPW入力が必須になっていません。");

console.log("folder password inheritance: ok");
