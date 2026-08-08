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
const rootResponse = await api("/folders", "admin", { method: "POST", body: JSON.stringify(root.payload) });
if (rootResponse.status !== 201) throw new Error(`最上位フォルダ作成: ${rootResponse.status}`);
const rootId = (await rootResponse.json()).id;

const child = await TRoomCrypto.createFolderPackage("HTTP配下", "", keyPair.publicKey, root.folderKey);
const missingRootPassword = await api("/folders", "admin", { method: "POST", body: JSON.stringify({ ...child.payload, parentId: null }) });
if (missingRootPassword.status !== 400) throw new Error(`最上位PWなし拒否: ${missingRootPassword.status}`);

const childResponse = await api("/folders", "admin", { method: "POST", body: JSON.stringify({ ...child.payload, parentId: rootId }) });
if (childResponse.status !== 201) throw new Error(`配下PWなし作成: ${childResponse.status}`);
const childId = (await childResponse.json()).id;

const itemsResponse = await api(`/items?folderId=${rootId}`, "admin", { method: "GET", headers: {} });
const items = await itemsResponse.json();
const childRecord = (items.folders || []).find((folder) => Number(folder.id) === Number(childId));
if (!childRecord || childRecord.isProtected || childRecord.passwordSalt || !childRecord.parentWrappedKey) throw new Error("配下フォルダの継承状態が正しくありません。");

const patchBody = JSON.stringify({ cryptoVersion: 1, encryptedName: child.payload.encryptedName, nameIv: child.payload.nameIv, passwordAction: "replace" });
const subadminPatch = await api(`/folders/${childId}`, "subadmin", { method: "PATCH", body: patchBody });
if (subadminPatch.status !== 403) throw new Error(`副管理者PW変更拒否: ${subadminPatch.status}`);
const adminPatch = await api(`/folders/${childId}`, "admin", { method: "PATCH", body: patchBody });
if (adminPatch.status !== 400) throw new Error(`継承フォルダ個別PW拒否: ${adminPatch.status}`);

console.log("folder inheritance HTTP routes: ok");
