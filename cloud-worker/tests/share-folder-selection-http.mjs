import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";

globalThis.window = globalThis;
await import("../public/vendor/argon2.umd.min.js");
await import("../public/crypto-vault.js");

const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8792";
const varsText = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(varsText.split(/\r?\n/)
  .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
  .filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, "")]));
if (!vars.SESSION_SECRET) throw new Error("ローカル用SESSION_SECRETがありません。");

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
async function sessionCookie(role, rootFolderId = null) {
  const payload = {
    role,
    label: role === "admin" ? "管理者" : role === "subadmin" ? "副管理者" : "一般ユーザー",
    sessionId: webcrypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    version: "5",
    ...(rootFolderId ? { rootFolderId } : {})
  };
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("raw", encoder.encode(vars.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64(new Uint8Array(await webcrypto.subtle.sign("HMAC", key, encoder.encode(encoded))));
  return `troom_cloud_session=${encoded}.${signature}`;
}

const cookies = {
  admin: await sessionCookie("admin"),
  subadmin: await sessionCookie("subadmin")
};
async function api(path, role, options = {}) {
  return fetch(`${origin}/cloud/api${path}`, {
    ...options,
    headers: {
      ...(role ? { Cookie: cookies[role] } : {}),
      Origin: origin,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
}
async function expectStatus(label, response, expected) {
  if (response.status !== expected) {
    const detail = await response.text();
    throw new Error(`${label}: expected ${expected}, received ${response.status}: ${detail}`);
  }
  return response;
}

const keyPair = await webcrypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  false,
  ["encrypt", "decrypt"]
);
async function createFolder(name, password, parent = null) {
  const pack = await TRoomCrypto.createFolderPackage(name, password, keyPair.publicKey, parent?.folderKey || null);
  const response = await expectStatus(`フォルダ作成 ${name}`, await api("/folders", "admin", {
    method: "POST",
    body: JSON.stringify({ ...pack.payload, name: pack.name, parentId: parent?.id || null })
  }), 201);
  return { id: Number((await response.json()).id), folderKey: pack.folderKey, payload: pack.payload, name };
}
async function uploadFile(folder, name) {
  const bytes = encoder.encode(`encrypted body for ${name}`);
  const pack = await TRoomCrypto.createFilePackage({ name, type: "text/plain", size: bytes.byteLength, lastModified: 1 }, folder.folderKey, "text");
  const created = await expectStatus(`ファイル作成 ${name}`, await api("/uploads", "admin", {
    method: "POST",
    body: JSON.stringify({ ...pack.payload, folderId: folder.id })
  }), 201);
  const upload = await created.json();
  const encrypted = await TRoomCrypto.encryptFileChunk(pack.fileKey, bytes, 0);
  const part = await expectStatus(`ファイル転送 ${name}`, await api(`/uploads/${upload.id}/parts/1`, "admin", {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: encrypted
  }), 200);
  await expectStatus(`ファイル確定 ${name}`, await api(`/uploads/${upload.id}/complete`, "admin", {
    method: "POST",
    body: JSON.stringify({ parts: [await part.json()] })
  }), 200);
  return { id: Number(upload.id), fileKey: pack.fileKey };
}
async function sharePayload(folders, password = "temporary-folder-share-password-2026") {
  const targetKey = folders[0].folderKey;
  const token = TRoomCrypto.toBase64Url(webcrypto.getRandomValues(new Uint8Array(32)));
  const passwordPackage = await TRoomCrypto.createSharePackage(targetKey, password);
  const tokenPackage = await TRoomCrypto.encryptShareToken(token, targetKey);
  const selectedFolders = await Promise.all(folders.map(async (folder, position) => ({
    id: folder.id,
    position,
    ...(position ? await TRoomCrypto.wrapFolderForShare(folder.folderKey, targetKey) : {})
  })));
  if (selectedFolders.some((folder) => "folderKey" in folder)) throw new Error("平文folder keyが共有API payloadへ含まれています。");
  return {
    token,
    password,
    body: {
      token,
      targetType: "folder-selection",
      targetId: folders[0].id,
      selectedFolders,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...passwordPackage,
      ...tokenPackage
    }
  };
}
async function createShare(folders, role = "admin") {
  const payload = await sharePayload(folders);
  const response = await expectStatus("複数フォルダ共有作成", await api("/shares", role, {
    method: "POST",
    body: JSON.stringify(payload.body)
  }), 201);
  return { ...payload, result: await response.json() };
}
async function createExistingShare(targetType, targets) {
  const records = Array.isArray(targets) ? targets : [targets];
  const targetKey = records[0].fileKey || records[0].folderKey;
  const token = TRoomCrypto.toBase64Url(webcrypto.getRandomValues(new Uint8Array(32)));
  const password = "temporary-existing-share-password-2026";
  const passwordPackage = await TRoomCrypto.createSharePackage(targetKey, password);
  const tokenPackage = await TRoomCrypto.encryptShareToken(token, targetKey);
  const selectedFiles = targetType === "selection"
    ? await Promise.all(records.map(async (file, position) => ({
        id: file.id,
        position,
        ...(position ? await TRoomCrypto.wrapFileForShare(file.fileKey, targetKey) : {})
      })))
    : undefined;
  const response = await expectStatus(`既存${targetType}共有作成`, await api("/shares", "admin", {
    method: "POST",
    body: JSON.stringify({
      token,
      targetType,
      targetId: records[0].id,
      selectedFiles,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...passwordPackage,
      ...tokenPackage
    })
  }), 201);
  return { token, password, result: await response.json() };
}
async function unlockShare(share, expectedType = "folder-selection") {
  const infoResponse = await expectStatus("共有情報", await api(`/public/shares/${share.token}`, null), 200);
  const info = await infoResponse.json();
  if (info.targetType !== expectedType) throw new Error(`${expectedType}共有として判定されていません。`);
  const authProof = await TRoomCrypto.deriveShareAuthProof(info, share.password);
  const unlock = await expectStatus("共有PW解除", await api(`/public/shares/${share.token}/unlock`, null, {
    method: "POST",
    body: JSON.stringify({ authProof })
  }), 200);
  return (unlock.headers.get("set-cookie") || "").split(";")[0];
}
async function publicRequest(share, path, cookie = "") {
  return fetch(`${origin}/cloud/api/public/shares/${share.token}${path}`, {
    headers: cookie ? { Cookie: cookie } : {}
  });
}

const rootA = await createFolder(`共有A-${Date.now()}`, "temporary-share-root-a");
const rootB = await createFolder(`共有B-${Date.now()}`, "temporary-share-root-b");
const rootC = await createFolder(`共有外C-${Date.now()}`, "temporary-share-root-c");
const childA = await createFolder("A配下", "", rootA);
const grandchildA = await createFolder("A孫", "", childA);
const childB = await createFolder("B配下", "", rootB);
const inScopeFile = await uploadFile(grandchildA, "共有範囲内.txt");
const outsideFile = await uploadFile(rootC, "共有範囲外.txt");
const outsideFile2 = await uploadFile(rootC, "既存複数ファイル共有.txt");

const share = await createShare([childA, rootB]);
if (!share.result.sharePath || share.result.targetType !== "folder-selection") throw new Error("共有URLが1件発行されていません。");
const publicCookie = await unlockShare(share);
const virtualRootResponse = await expectStatus("仮想共有ルート", await publicRequest(share, "/items", publicCookie), 200);
const virtualRoot = await virtualRootResponse.json();
if (virtualRoot.folders?.length !== 2 || virtualRoot.files?.length !== 0) throw new Error("仮想共有ルートのフォルダ一覧が正しくありません。");
await expectStatus("選択ルートA", await publicRequest(share, `/items?folderId=${childA.id}`, publicCookie), 200);
await expectStatus("選択ルートB", await publicRequest(share, `/items?folderId=${rootB.id}`, publicCookie), 200);
await expectStatus("選択ルートA配下", await publicRequest(share, `/items?folderId=${grandchildA.id}`, publicCookie), 200);
await expectStatus("選択ルートB配下", await publicRequest(share, `/items?folderId=${childB.id}`, publicCookie), 200);
await expectStatus("親フォルダ遡及拒否", await publicRequest(share, `/items?folderId=${rootA.id}`, publicCookie), 403);
await expectStatus("選択外フォルダ拒否", await publicRequest(share, `/items?folderId=${rootC.id}`, publicCookie), 403);
await expectStatus("範囲内fileId", await publicRequest(share, `/files/${inScopeFile.id}/view`, publicCookie), 200);
await expectStatus("範囲外fileId拒否", await publicRequest(share, `/files/${outsideFile.id}/view`, publicCookie), 403);
await expectStatus("範囲外thumbnail拒否", await publicRequest(share, `/files/${outsideFile.id}/thumbnail`, publicCookie), 403);

execFileSync(process.execPath, ["tests/share-security.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    TEST_SHARE_ORIGIN: origin,
    TEST_SHARE_TOKEN: share.token,
    TEST_SHARE_ID: String(share.result.id),
    TEST_SHARE_ROOT_ID: String(childA.id),
    TEST_SHARE_OUTSIDE_ID: String(rootC.id)
  },
  stdio: "inherit"
});

const existingFolderShare = await createExistingShare("folder", rootC);
const existingFolderCookie = await unlockShare(existingFolderShare, "folder");
await expectStatus("既存単一フォルダ共有", await publicRequest(existingFolderShare, "/items", existingFolderCookie), 200);
const existingFileShare = await createExistingShare("file", outsideFile);
const existingFileCookie = await unlockShare(existingFileShare, "file");
await expectStatus("既存単一ファイル共有", await publicRequest(existingFileShare, "/items", existingFileCookie), 200);
const existingSelectionShare = await createExistingShare("selection", [outsideFile, outsideFile2]);
const existingSelectionCookie = await unlockShare(existingSelectionShare, "selection");
const existingSelectionItems = await expectStatus("既存複数ファイル共有", await publicRequest(existingSelectionShare, "/items", existingSelectionCookie), 200);
if ((await existingSelectionItems.json()).files?.length !== 2) throw new Error("既存複数ファイル共有の対象件数が一致しません。");

const duplicate = await sharePayload([childA, rootB]);
duplicate.body.selectedFolders[1].id = childA.id;
await expectStatus("重複フォルダ拒否", await api("/shares", "admin", { method: "POST", body: JSON.stringify(duplicate.body) }), 400);
const missing = await sharePayload([childA, rootB]);
missing.body.selectedFolders[1].id = 2147483647;
await expectStatus("存在しないフォルダ拒否", await api("/shares", "admin", { method: "POST", body: JSON.stringify(missing.body) }), 404);
const tooMany = await sharePayload([childA, rootB]);
tooMany.body.selectedFolders = Array.from({ length: 101 }, (_, position) => ({ id: position + 1, position }));
await expectStatus("101件拒否", await api("/shares", "admin", { method: "POST", body: JSON.stringify(tooMany.body) }), 400);

cookies.member = await sessionCookie("member", childA.id);
await expectStatus("member共有作成拒否", await api("/shares", "member", {
  method: "POST",
  body: JSON.stringify((await sharePayload([childA, rootB])).body)
}), 403);

await expectStatus("副管理者A解除", await api(`/folders/${rootA.id}/unlock`, "subadmin", {
  method: "POST", body: JSON.stringify({ authProof: rootA.payload.authProof })
}), 200);
await expectStatus("副管理者B解除", await api(`/folders/${rootB.id}/unlock`, "subadmin", {
  method: "POST", body: JSON.stringify({ authProof: rootB.payload.authProof })
}), 200);
await createShare([childA, rootB], "subadmin");
await expectStatus("副管理者の未解除範囲拒否", await api("/shares", "subadmin", {
  method: "POST",
  body: JSON.stringify((await sharePayload([childA, rootC])).body)
}), 423);

const hundredFolders = [];
for (let index = 0; index < 100; index++) hundredFolders.push(await createFolder(`上限確認-${index + 1}`, "", rootA));
const hundredShare = await createShare(hundredFolders);
if (!hundredShare.result.sharePath) throw new Error("100フォルダ共有を作成できません。");

const expiredShare = await createShare(hundredFolders.slice(0, 2));
const expiredAt = Math.floor(Date.now() / 1000) - 1;
execSync(`pnpm exec wrangler d1 execute cloud-db --local --command "UPDATE cloud_shares SET expires_at = ${expiredAt} WHERE id = ${Number(expiredShare.result.id)}"`, { stdio: "ignore" });
await expectStatus("期限切れアクセス拒否", await publicRequest(expiredShare, ""), 410);

await expectStatus("共有停止", await api(`/shares/${share.result.id}/stop`, "admin", { method: "POST", body: "{}" }), 200);
await expectStatus("停止後アクセス拒否", await publicRequest(share, "/items", publicCookie), 410);

const deletionShare = await createShare([childA, rootB]);
const deletionCookie = await unlockShare(deletionShare);
await expectStatus("選択root B削除", await api(`/folders/${rootB.id}`, "admin", { method: "DELETE", body: "{}" }), 200);
const remaining = await expectStatus("一部削除後の残存root", await publicRequest(deletionShare, "/items", deletionCookie), 200);
if ((await remaining.json()).folders?.length !== 1) throw new Error("削除されていない共有rootを利用できません。");
await expectStatus("最後の選択root削除", await api(`/folders/${childA.id}`, "admin", { method: "DELETE", body: "{}" }), 200);
await expectStatus("全root削除後利用不可", await publicRequest(deletionShare, "", deletionCookie), 410);

console.log("multiple-folder share HTTP security and lifecycle: ok");
