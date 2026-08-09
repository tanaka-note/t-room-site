import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

if (!worker.includes("normalizeEncryptedFolder(body, false)")) throw new Error("フォルダPWが任意になっていません。");
if (!worker.includes("const passwordHash = encrypted.authProof ? await hashPassword(encrypted.authProof) : null")) throw new Error("配下フォルダのPW継承処理がありません。");
if (!worker.includes("requireFolderEdit(session)")) throw new Error("PW再設定の管理者権限確認がありません。");
if (!worker.includes("個別PWがない配下フォルダでは、作成後にPWを追加できません")) throw new Error("個別PWなしフォルダの制約がありません。");
if (!client.includes('const password = $("#folder-password-enabled").checked ? $("#folder-password").value : ""')) throw new Error("新規フォルダのPW選択処理がありません。");
if (!client.includes('createEncryptedFolder(parts.at(-1), inheritedParent.id, inheritedParent.key, "")')) throw new Error("フォルダアップロードがPWなしになっていません。");
if (!client.includes("TRoomCrypto.unlockFolderFromParent(folder, parentKey)")) throw new Error("親フォルダ鍵による自動解除がありません。");
for (const id of ["folder-password-enabled", "folder-password-row", "folder-password-settings-row", "folder-inherited-settings-note"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`${id} がありません。`);
}
if (html.includes('id="folder-inherit-note"') || html.includes('id="folder-upload-inherit-note"')) throw new Error("不要な保護継承文言が残っています。");
if (!html.includes('id="folder-password-row" hidden')) throw new Error("PW入力欄が初期状態で非表示ではありません。");

console.log("folder password inheritance: ok");
