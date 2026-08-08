import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

if (!worker.includes("normalizeEncryptedFolder(body, !parentId)")) throw new Error("最上位フォルダのPW必須判定がありません。");
if (!worker.includes("const passwordHash = encrypted.authProof ? await hashPassword(encrypted.authProof) : null")) throw new Error("配下フォルダのPW継承処理がありません。");
if (!worker.includes("requireFolderEdit(session)")) throw new Error("PW再設定の管理者権限確認がありません。");
if (!worker.includes("親フォルダの保護を引き継ぐフォルダには個別PWを設定できません")) throw new Error("継承フォルダへの個別PW設定を拒否していません。");
if (!client.includes('const password = state.folderId ? "" : $("#folder-password").value')) throw new Error("配下フォルダでPW入力を省略していません。");
if (!client.includes("TRoomCrypto.unlockFolderFromParent(folder, parentKey)")) throw new Error("親フォルダ鍵による自動解除がありません。");
for (const id of ["folder-password-row", "folder-inherit-note", "folder-password-settings-row", "folder-inherited-settings-note"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`${id} がありません。`);
}

console.log("folder password inheritance: ok");
