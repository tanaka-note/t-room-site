import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

globalThis.window = globalThis;
await import("../public/vendor/argon2.umd.min.js");
await import("../public/crypto-vault.js");

const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8793";
const varsText = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(varsText.split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, "")]));
if (!vars.SESSION_SECRET) throw new Error("ローカル用SESSION_SECRETがありません。");

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
async function cookie(role) {
  const payload = { role, label: role === "admin" ? "管理者" : "副管理者", sessionId: webcrypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 3600, version: "3" };
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("raw", encoder.encode(vars.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64(new Uint8Array(await webcrypto.subtle.sign("HMAC", key, encoder.encode(encoded))));
  return `troom_cloud_session=${encoded}.${signature}`;
}
async function api(path, role, options = {}) {
  return fetch(`${origin}/cloud/api${path}`, {
    ...options,
    headers: { Cookie: await cookie(role), Origin: origin, "Content-Type": "application/json", ...(options.headers || {}) }
  });
}

const keyPair = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["encrypt", "decrypt"]);
const root = await TRoomCrypto.createFolderPackage("HTTPルート", "temporary-root-password", keyPair.publicKey);
const rootResponse = await api("/folders", "admin", { method: "POST", body: JSON.stringify({ ...root.payload, name: root.name }) });
if (rootResponse.status !== 201) throw new Error(`最上位フォルダ作成: ${rootResponse.status}`);
const rootId = (await rootResponse.json()).id;

const child = await TRoomCrypto.createFolderPackage("HTTP配下", "", keyPair.publicKey, root.folderKey);
const unprotectedRoot = await TRoomCrypto.createFolderPackage("HTTP最上位PWなし", "", keyPair.publicKey);
const unprotectedRootResponse = await api("/folders", "admin", { method: "POST", body: JSON.stringify({ ...unprotectedRoot.payload, name: unprotectedRoot.name, parentId: null }) });
if (unprotectedRootResponse.status !== 201) throw new Error(`最上位PWなし作成: ${unprotectedRootResponse.status}`);

const childResponse = await api("/folders", "admin", { method: "POST", body: JSON.stringify({ ...child.payload, name: child.name, parentId: rootId }) });
if (childResponse.status !== 201) throw new Error(`配下PWなし作成: ${childResponse.status}`);
const childId = (await childResponse.json()).id;

const protectedChild = await TRoomCrypto.createFolderPackage("HTTP配下PWあり", "temporary-child-password", keyPair.publicKey, root.folderKey);
const protectedChildResponse = await api("/folders", "admin", { method: "POST", body: JSON.stringify({ ...protectedChild.payload, name: protectedChild.name, parentId: rootId }) });
if (protectedChildResponse.status !== 201) throw new Error(`配下PWあり作成: ${protectedChildResponse.status}`);

const itemsResponse = await api(`/items?folderId=${rootId}`, "admin", { method: "GET", headers: {} });
const items = await itemsResponse.json();
const childRecord = (items.folders || []).find((folder) => Number(folder.id) === Number(childId));
if (!childRecord || childRecord.isProtected || childRecord.passwordSalt || !childRecord.parentWrappedKey) throw new Error("配下フォルダの継承状態が正しくありません。");
if (childRecord.name !== child.name) throw new Error("フォルダ名が平文表示用として保存されていません。");
if (Number(childRecord.fileCount) !== 0 || Number(childRecord.folderCount) !== 0) throw new Error("フォルダ件数の初期値が正しくありません。");
if (Number(items.folder?.folderCount) < 1) throw new Error("開いているフォルダの件数集計が正しくありません。");

const renamedChild = "HTTP配下・名称変更済み";
const renameBody = JSON.stringify({ name: renamedChild, passwordAction: "keep" });
const subadminPatch = await api(`/folders/${childId}`, "subadmin", { method: "PATCH", body: renameBody });
if (subadminPatch.status !== 403) throw new Error(`副管理者の名称変更拒否: ${subadminPatch.status}`);
const adminRename = await api(`/folders/${childId}`, "admin", { method: "PATCH", body: renameBody });
if (adminRename.status !== 200) throw new Error(`管理者の名称変更: ${adminRename.status}`);
const renamedItems = await (await api(`/items?folderId=${rootId}`, "admin", { method: "GET", headers: {} })).json();
if (!(renamedItems.folders || []).some((folder) => Number(folder.id) === Number(childId) && folder.name === renamedChild)) {
  throw new Error("変更後のフォルダ名が一覧へ反映されていません。");
}

const inheritedPassword = await TRoomCrypto.rewrapFolderPassword(child.folderKey, "temporary-child-password");
const inheritedPasswordPatch = await api(`/folders/${childId}`, "admin", {
  method: "PATCH",
  body: JSON.stringify({ name: renamedChild, passwordAction: "replace", ...inheritedPassword })
});
if (inheritedPasswordPatch.status !== 400) throw new Error(`継承フォルダ個別PW拒否: ${inheritedPasswordPatch.status}`);

const fileBytes = new TextEncoder().encode("rename-http-test-body");
const fileSource = { name: "変更前の写真.jpg", type: "image/jpeg", size: fileBytes.byteLength, lastModified: 1 };
const filePackage = await TRoomCrypto.createFilePackage(fileSource, child.folderKey, "image");
const uploadResponse = await api("/uploads", "admin", {
  method: "POST",
  body: JSON.stringify({ ...filePackage.payload, folderId: childId })
});
if (uploadResponse.status !== 201) throw new Error(`名称変更用ファイル作成: ${uploadResponse.status}`);
const upload = await uploadResponse.json();
const encryptedChunk = await TRoomCrypto.encryptFileChunk(filePackage.fileKey, fileBytes, 0);
const partResponse = await api(`/uploads/${upload.id}/parts/1`, "admin", {
  method: "PUT",
  headers: { "Content-Type": "application/octet-stream" },
  body: encryptedChunk
});
if (partResponse.status !== 200) throw new Error(`名称変更用ファイル転送: ${partResponse.status}`);
const part = await partResponse.json();
const completeResponse = await api(`/uploads/${upload.id}/complete`, "admin", {
  method: "POST",
  body: JSON.stringify({ parts: [part] })
});
if (completeResponse.status !== 200) throw new Error(`名称変更用ファイル保存: ${completeResponse.status}`);

const changedFileName = "日本語・記号 OK（変更後）.jpg";
const renamedFileMetadata = await TRoomCrypto.encryptFileMetadata({ name: changedFileName, mimeType: "image/jpeg", mediaKind: "image" }, filePackage.fileKey);
const renameFileResponse = await api(`/files/${upload.id}`, "admin", {
  method: "PATCH",
  body: JSON.stringify(renamedFileMetadata)
});
if (renameFileResponse.status !== 200) throw new Error(`ファイル名変更: ${renameFileResponse.status}`);
const updatedFile = (await (await api(`/files/${upload.id}`, "admin", { method: "GET", headers: {} })).json()).file;
const updatedMetadata = await TRoomCrypto.decryptFileMetadata(updatedFile, filePackage.fileKey);
if (updatedMetadata.name !== changedFileName) throw new Error("変更後のファイル名が暗号化メタデータへ保存されていません。");

console.log("folder inheritance HTTP routes: ok");
