import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { pbkdf2Sync } from "node:crypto";
import { sessionCookieValue, sessionPolicyForAuthMethod, shouldRefreshSession } from "../../assets/session-policy.mjs";
import { validateServicePasskeySession } from "../../assets/passkey-session-validation.mjs";

const db = new DatabaseSync(":memory:");
for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
const salt = Buffer.from("local-test-salt");
const proofHash = `pbkdf2-sha256$100000$${salt.toString("base64url")}$${pbkdf2Sync("local-proof", salt, 100000, 32, "sha256").toString("base64url")}`;
db.prepare(`INSERT INTO cloud_folders(id,parent_id,name,password_hash,created_by) VALUES
 (7,NULL,'Atsushi',?,'admin'),(8,7,'child',NULL,'admin'),(9,NULL,'other',?,'admin'),(10,7,'locked child',?,'admin'),(11,10,'locked descendant',NULL,'admin')`).run(proofHash, proofHash, proofHash);
db.exec(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by) VALUES
 (1,7,'own','own.txt','text/plain','document',1,'ready','member'),(2,9,'outside','other.txt','text/plain','document',1,'ready','member'),
 (3,NULL,'unfiled','unfiled.txt','text/plain','document',1,'ready','member'),(4,11,'locked','locked.txt','text/plain','document',1,'ready','member');`);
function statement(sql, args = []) {
  const prepared = db.prepare(sql);
  return { bind(...values) { return statement(sql, values); }, async first() { return prepared.get(...args) || null; }, async all() { return { results: prepared.all(...args) }; }, async run() { const result = prepared.run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; } };
}
let selected;
const access = [];
const env = { DB: { prepare: statement, async batch(statements) { return Promise.all(statements.map((s) => s.run())); } },
  SESSION_SECRET: "local-only-test-secret", SESSION_VERSION: "5", PASSKEY_ENABLED: "true", ACCOUNT_KDF_ID: "test",
  ADMIN_LOGIN_ID: "admin@test", SUBADMIN_LOGIN_ID: "subadmin@test", ADMIN_AUTH_PROOF_HASH: proofHash, SUBADMIN_AUTH_PROOF_HASH: proofHash,
  SECURITY: { async redeemHandoff() { return selected; }, async validatePasskeySession(input) { return { valid: input.serviceAccountId === "admin" ? input.cloudRootFolderId == null : input.serviceAccountId === "folder-member" && input.cloudRootFolderId === 7 }; } },
  FILES: { async createMultipartUpload() { return { uploadId: "fixture-upload" }; }, resumeMultipartUpload() { return { async abort() {}, async uploadPart() { return { partNumber: 1, etag: "fixture" }; } }; }, async get() { access.push("read"); return null; }, async head() { access.push("head"); return null; } }
};
const context = { WorkerEntrypoint: class {}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, atob, btoa, console,
  sessionCookieValue, sessionPolicyForAuthMethod, shouldRefreshSession, validateServicePasskeySession,
  recordSecurityAudit: async () => {}, enqueueSecurityAudit: () => {}, handleYouTubeSearchRequest: async () => new Response("{}") };
context.globalThis = context;
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export class SecurityIntegration", "class SecurityIntegration").replace("export default {", "globalThis.worker = {");
vm.runInNewContext(source, context);
async function api(cookie, path, method = "GET", body) {
  const request = new Request(`https://example.test/cloud/api${path}`, { method,
    headers: { Origin: "https://example.test", ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await context.worker.fetch(request, env, { waitUntil() {} });
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function handoff(account, identity = "primary-admin") {
  selected = { identityId: identity, credentialId: "credential", serviceLinkId: `${identity}-${account}`, serviceAccountId: account, cloudRootFolderId: account === "folder-member" ? 7 : null, displayLabel: account === "folder-member" ? "Atsushi" : "管理者", sessionEpoch: 1 };
  const result = await api(null, "/passkey/handoff", "POST", { handoffToken: "fixture" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result;
}
try {
  const admin = await handoff("admin");
  assert.deepEqual((await api(admin.cookie, "/items")).body.folders.map((f) => f.id).sort(), [7, 9]);
  for (const identity of ["primary-admin", "general-user"]) {
    const member = await handoff("folder-member", identity);
    assert.equal(member.body.role, "member"); assert.equal(member.body.canDelete, false);
    assert.deepEqual((await api(member.cookie, "/items")).body.folders.map((f) => f.id), [7]);
    const resume = await api(member.cookie, "/session");
    assert.equal(resume.body.serviceAccountId, "folder-member"); assert.equal(resume.body.rootFolderId, 7);
    for (const path of ["/items?folderId=9", "/player/media?rootFolderId=9", "/usage", "/trash", "/shares", "/upload-history"]) assert.equal((await api(member.cookie, path)).status, 403, path);
    for (const id of [2, 3]) for (const suffix of ["", "/thumbnail", "/display-thumbnail", "/view", "/download"]) assert.equal((await api(member.cookie, `/files/${id}${suffix}`)).status, 403, `${id}${suffix}`);
    assert.equal(access.length, 0, "root checks happen before R2 access");
    for (const [path, method, body] of [
      ["/folders/9/unlock", "POST", { password: "local-proof" }], ["/folders/9", "PATCH", { name: "bad" }], ["/folders/9", "DELETE"],
      ["/folders", "POST", { parentId: 9, name: "bad" }], ["/folders/8", "PATCH", { name: "child", parentId: 9 }],
      ["/files/2", "PATCH", { name: "bad" }], ["/files/3", "PATCH", { name: "bad" }], ["/files/2", "DELETE"],
      ["/files/1", "PATCH", { folderId: 9 }], ["/shares", "POST", { targetType: "file", targetId: 2 }],
      ["/upload-conflict-candidates", "POST", { sizes: [1], folderId: 9 }]
    ]) assert.equal((await api(member.cookie, path, method, body)).status, 403, `${method} ${path}`);
    assert.equal((await api(member.cookie, "/items?folderId=10")).status, 423);
    assert.equal((await api(member.cookie, "/files/4")).status, 423);
    const search = await api(member.cookie, "/items?q=other&recursive=1");
    assert.equal(search.status, 200); assert.equal(search.body.files.some((file) => [2, 3, 4].includes(file.id)), false);
    assert.equal((await api(member.cookie, "/move-destinations")).body.folders.some((f) => f.id === 9), false);
    assert.equal((await api(member.cookie, "/files/1", "PATCH", { name: "own.txt", folderId: 8 })).status, 200);
    assert.equal((await api(member.cookie, "/files/1", "PATCH", { folderId: 7 })).status, 200);
    assert.equal((await api(member.cookie, "/folders/8", "PATCH", { name: "child" })).status, 200);
    assert.equal((await api(member.cookie, "/folders/10/unlock", "POST", { password: "local-proof" })).status, 200);
    assert.equal((await api(member.cookie, "/files/4")).status, 200);
    const folderBody = { parentId: 8, name: "created", cryptoVersion: 1, inheritsProtection: true, encryptedName: "AA", nameIv: "AA", adminWrappedKey: "AA", parentWrappedKey: "AA", parentWrapIv: "AA" };
    const folder = await api(member.cookie, "/folders", "POST", folderBody);
    assert.equal(folder.status, 201, JSON.stringify(folder.body));
    assert.equal((await api(member.cookie, `/folders/${folder.body.id}`, "DELETE")).status, 200);
    const uploadBody = { folderId: 7, sizeBytes: 1, cryptoVersion: 1, encryptedMetadata: "AA", metadataIv: "AA", wrappedFileKey: "AA", fileKeyIv: "AA", encryptedSizeBytes: 33, chunkSizeBytes: 8388608, chunkCount: 1 };
    assert.equal((await api(member.cookie, "/uploads", "POST", { ...uploadBody, folderId: 9 })).status, 403);
    const upload = await api(member.cookie, "/uploads", "POST", uploadBody);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal((await api(member.cookie, `/uploads/${upload.body.id}`, "DELETE")).status, 200);
  }
  const pw = await api(null, "/login", "POST", { loginId: "subadmin@test", authProof: "local-proof" });
  assert.equal(pw.status, 200); assert.equal(pw.body.role, "subadmin");
  assert.equal((await api(pw.cookie, "/items")).body.folders.length, 2);
  assert.equal((await api(pw.cookie, "/items?folderId=7")).status, 423);
  assert.equal((await api(pw.cookie, "/folders/7/unlock", "POST", { password: "local-proof" })).status, 200);
  assert.equal((await api(pw.cookie, "/files/1", "PATCH", { name: "renamed.txt" })).status, 200);
  assert.equal((await api(pw.cookie, "/files/1", "DELETE")).status, 200);
  assert.equal((await api(pw.cookie, "/files/1/permanent", "DELETE")).status, 403);
  console.log("member API boundary: primary and general member use identical scope; PW subadmin regression passed");
} finally { db.close(); }
