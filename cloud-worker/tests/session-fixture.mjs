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
  SECURITY: { async redeemHandoff(token) { return selected || {identityId:"primary-admin",credentialId:"credential",serviceLinkId:`primary-admin-${token}`,serviceAccountId:token,cloudRootFolderId:token === "folder-member" ? 7 : null,displayLabel:token === "admin" ? "管理者" : "Atsushi",sessionEpoch:1}; }, async validatePasskeySession(input) { return { valid: input.serviceAccountId === "admin" ? input.cloudRootFolderId == null : input.serviceAccountId === "folder-member" && input.cloudRootFolderId === 7 }; } },
  FILES: { async createMultipartUpload() { return { uploadId: "fixture-upload" }; }, resumeMultipartUpload() { return { async abort() {}, async uploadPart() { return { partNumber: 1, etag: "fixture" }; } }; }, async get() { access.push("read"); return null; }, async head() { access.push("head"); return null; } }
};
const context = { WorkerEntrypoint: class {}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, atob, btoa, console,
  sessionCookieValue, sessionPolicyForAuthMethod, shouldRefreshSession, validateServicePasskeySession,
  recordSecurityAudit: async () => {}, enqueueSecurityAudit: () => {}, handleYouTubeSearchRequest: async () => new Response("{}") };
context.globalThis = context;
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export class SecurityIntegration", "class SecurityIntegration").replace("export default {", "globalThis.worker = {");
vm.runInNewContext(source, context);
async function api(cookie, path, method = "GET", body, extraHeaders = {}) {
  const request = new Request(`https://example.test/cloud/api${path}`, { method,
    headers: { Origin: "https://example.test", ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await context.worker.fetch(request, env, { waitUntil() {} });
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function handoff(account, identity = "primary-admin") {
  selected = { identityId: identity, credentialId: "credential", serviceLinkId: `${identity}-${account}`, serviceAccountId: account, cloudRootFolderId: account === "folder-member" ? 7 : null, displayLabel: account === "folder-member" ? "Atsushi" : "管理者", sessionEpoch: 1 };
  const result = await api(null, "/passkey/handoff", "POST", { handoffToken: "fixture" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result;
}
export {db, env, context, api, handoff};
