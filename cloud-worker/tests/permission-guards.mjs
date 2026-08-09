import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} が見つかりません。`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`${name} の終端が見つかりません。`);
}

function requires(name, guard) {
  const body = functionBody(name);
  if (!body.includes(`${guard}(session)`)) throw new Error(`${name} に ${guard} がありません。`);
}

for (const name of ["createShare", "listShares", "stopShare", "listAdminShareEvents"]) requires(name, "requireAdmin");
for (const name of ["createFolder", "createUpload", "uploadPart", "completeUpload", "cancelUpload", "putThumbnail"]) requires(name, "requireUpload");
for (const name of ["restoreFolder", "restoreFile", "permanentlyDeleteFile", "listTrash"]) requires(name, "requireDelete");
requires("updateFolder", "requireFolderEdit");
requires("updateFile", "requireFileEdit");
requires("requestFileDeletion", "requireDeletionRequest");
for (const name of ["listDeletionRequests", "approveDeletionRequest"]) requires(name, "requireDeletionReview");

for (const name of ["uploadPart", "completeUpload", "cancelUpload"]) {
  if (!functionBody(name).includes("requireUploadOwnership(session, file)")) throw new Error(`${name} に処理途中アップロードの所有者確認がありません。`);
}

if (!source.includes('role: "subadmin"') || !source.includes("canDelete: false") || !source.includes("canEditFiles: false") || !source.includes("canEditFolders: false")) {
  throw new Error("副管理者の禁止権限を確認できません。");
}
if (!source.includes('role: "subadmin"') || !source.includes("canRenameUnlockedItems: true")) {
  throw new Error("副管理者の解除済みフォルダ内名称変更権限を確認できません。");
}
if (!functionBody("updateFile").includes("if (!unlocked)") || !functionBody("updateFile").includes("if (moving)")) {
  throw new Error("副管理者のファイル名変更が解除済みフォルダ内に限定されていません。");
}
if (!functionBody("updateFolder").includes("if (!unlocked)") || !functionBody("updateFolder").includes('passwordAction !== "keep"')) {
  throw new Error("副管理者のフォルダ名変更が解除済み・PW維持に限定されていません。");
}
if (!functionBody("moveFileToTrash").includes("canTrashUnlockedFiles") || !functionBody("moveFileToTrash").includes("requireFolderAccess(env, file.folder_id, session)")) {
  throw new Error("副管理者のPW解除済みフォルダ内削除を確認できません。");
}
if (!functionBody("deleteFolder").includes("canTrashUnlockedFiles")
  || !functionBody("deleteFolder").includes("folder.parent_id")
  || !functionBody("deleteFolder").includes("requireFolderAccess(env, folder.parent_id, session)")) {
  throw new Error("副管理者のPW解除済みフォルダ配下の削除制限を確認できません。");
}
if (!functionBody("getUsage").includes("requireAdmin(session)")) throw new Error("容量内訳が管理者専用ではありません。");
if (source.includes("purgeExpiredTrash(env)")) throw new Error("30日後の自動完全削除が残っています。");
if (!functionBody("listUploadHistory").includes('session.role === "admin"') || !functionBody("listUploadHistory").includes("l.actor_role = ?")) {
  throw new Error("操作履歴の役割別フィルターを確認できません。");
}

console.log("permission guards: ok");
