import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8792";
const varsText = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
const vars = Object.fromEntries(varsText.split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((match) => [match[1], match[2].replace(/^['"]|['"]$/g, "")]));
if (!vars.SESSION_SECRET) throw new Error("ローカル用SESSION_SECRETがありません。");

const encoder = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
async function cookie(role) {
  const payload = {
    role,
    label: role === "admin" ? "管理者" : "副管理者",
    sessionId: webcrypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 3600,
    version: "4"
  };
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const key = await webcrypto.subtle.importKey("raw", encoder.encode(vars.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64(new Uint8Array(await webcrypto.subtle.sign("HMAC", key, encoder.encode(encoded))));
  return `troom_cloud_session=${encoded}.${signature}`;
}

async function request(path, role, options = {}) {
  const headers = { ...(role ? { Cookie: await cookie(role) } : {}), ...(options.headers || {}) };
  return fetch(`${origin}/cloud/api${path}`, { ...options, headers });
}

async function expectStatus(label, response, expected) {
  if (response.status !== expected) throw new Error(`${label}: expected ${expected}, received ${response.status}`);
  return response;
}

await expectStatus("未認証の一覧", await request("/items", null), 401);
const adminSessionResponse = await expectStatus("管理者セッション", await request("/session", "admin"), 200);
if (!/Max-Age=2592000/.test(adminSessionResponse.headers.get("Set-Cookie") || "")) throw new Error("管理者セッションが最終利用から30日へ更新されていません。");
const subadminSessionResponse = await expectStatus("副管理者セッション", await request("/session", "subadmin"), 200);
if (!/Max-Age=2592000/.test(subadminSessionResponse.headers.get("Set-Cookie") || "")) throw new Error("副管理者セッションが最終利用から30日へ更新されていません。");
await expectStatus("副管理者のゴミ箱拒否", await request("/trash", "subadmin"), 403);
await expectStatus("副管理者の共有管理拒否", await request("/shares", "subadmin"), 403);
await expectStatus("副管理者の削除承認一覧拒否", await request("/deletion-requests", "subadmin"), 403);
await expectStatus("副管理者の存在しないファイル名称変更", await request("/files/999999", "subadmin", { method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }), 404);
await expectStatus("副管理者の存在しないフォルダ名称変更", await request("/folders/999999", "subadmin", { method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }), 404);
await expectStatus("管理者の再ロック拒否", await request("/folders/999999/unlock", "admin", { method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" }), 403);
await expectStatus("最上位フォルダのPW必須", await request("/folders", "admin", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ name: "password-required-check", cryptoVersion: 1 }) }), 400);
await expectStatus("副管理者の存在しないファイル削除", await request("/files/999999", "subadmin", { method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" } }), 404);
await expectStatus("副管理者の容量内訳拒否", await request("/usage", "subadmin"), 403);
await expectStatus("副管理者のフォルダ別容量内訳拒否", await request("/usage-details", "subadmin"), 403);
const adminItemsResponse = await expectStatus("管理者の保存先候補取得", await request("/items", "admin"), 200);
const adminItems = await adminItemsResponse.json();
const protectedShareFolderId = Number(adminItems.folders?.[0]?.id || 0);
if (protectedShareFolderId) {
  await expectStatus("副管理者の未解除フォルダ共有拒否", await request("/shares", "subadmin", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "A".repeat(43), targetType: "folder", targetId: protectedShareFolderId, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  }), 423);
}
const moveDestinationsResponse = await expectStatus("管理者の移動先一括取得", await request("/move-destinations", "admin"), 200);
const moveDestinations = await moveDestinationsResponse.json();
if (!Array.isArray(moveDestinations.folders)) throw new Error("移動先フォルダ一覧を取得できません。");
if (moveDestinations.folders.some((folder) => "adminWrappedKey" in folder || "passwordWrappedKey" in folder)) {
  throw new Error("移動先一覧へ不要な暗号鍵情報が含まれています。");
}
await expectStatus("副管理者の解除範囲指定必須", await request("/move-destinations", "subadmin"), 400);
const uploadDestinationFolderId = Number(adminItems.folders?.[0]?.id || 0);
if (uploadDestinationFolderId) {
  await expectStatus("管理者の保存先限定競合候補照合", await request("/upload-conflict-candidates", "admin", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ sizes: [123456789], folderId: uploadDestinationFolderId, offset: 0 }) }), 200);
}
await expectStatus("競合候補照合の保存先指定必須", await request("/upload-conflict-candidates", "admin", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ sizes: [123456789], offset: 0 }) }), 400);
await expectStatus("競合候補照合の容量指定検証", await request("/upload-conflict-candidates", "admin", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ sizes: [] }) }), 400);
await expectStatus("管理者の保存済み競合グループ照合", await request("/conflicts?offset=0", "admin"), 200);
await expectStatus("副管理者の解除範囲内保存済み競合グループ照合", await request("/conflicts?offset=0", "subadmin"), 200);

const subHistoryResponse = await expectStatus("副管理者本人の操作履歴", await request("/upload-history", "subadmin"), 200);
const subHistory = await subHistoryResponse.json();
if ((subHistory.history || []).some((item) => item.actorRole !== "subadmin")) throw new Error("副管理者の履歴に管理者の操作が含まれています。");
await expectStatus("管理者の操作履歴", await request("/upload-history", "admin"), 200);
await expectStatus("管理者のゴミ箱", await request("/trash", "admin"), 200);
await expectStatus("管理者の共有管理", await request("/shares", "admin"), 200);
await expectStatus("管理者の容量内訳", await request("/usage", "admin"), 200);
await expectStatus("管理者のフォルダ別容量内訳", await request("/usage-details", "admin"), 200);

console.log("permission HTTP routes: ok");
