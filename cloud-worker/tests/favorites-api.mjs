import { isValidSessionSecret, requireSessionSecret } from "../../assets/session-secret.mjs";
import assert from "node:assert/strict";
import { accountDisplayName } from "../../assets/account-display.mjs";
import { lineBrowserResponse } from "../../assets/line-browser-worker.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { sessionCookieValue, sessionPolicyForAuthMethod, shouldRefreshSession, passwordLifetimeClaims, validSessionLifetime, sessionExpiresAt } from "../../assets/session-policy.mjs";
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
  SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "5", PASSKEY_ENABLED: "true", ACCOUNT_KDF_ID: "test",
  ADMIN_LOGIN_ID: "admin@test", SUBADMIN_LOGIN_ID: "subadmin@test", ADMIN_AUTH_PROOF_HASH: proofHash, SUBADMIN_AUTH_PROOF_HASH: proofHash,
  SECURITY: { async redeemHandoff() { return selected; }, async validatePasskeySession(input) { return { valid: input.serviceAccountId === "admin" ? input.cloudRootFolderId == null : input.serviceAccountId === "folder-member" && input.cloudRootFolderId === 7 }; } },
  FILES: { async createMultipartUpload() { return { uploadId: "fixture-upload" }; }, resumeMultipartUpload() { return { async abort() {}, async uploadPart() { return { partNumber: 1, etag: "fixture" }; } }; }, async get() { access.push("read"); return null; }, async head() { access.push("head"); return null; } }
};
const context = { isValidSessionSecret, requireSessionSecret, accountDisplayName, lineBrowserResponse, WorkerEntrypoint: class {}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, atob, btoa, console,
  sessionCookieValue, sessionPolicyForAuthMethod, shouldRefreshSession, passwordLifetimeClaims, validSessionLifetime, sessionExpiresAt, validateServicePasskeySession,
  recordSecurityAudit: async () => {}, enqueueSecurityAudit: () => {}, handleYouTubeSearchRequest: async () => new Response("{}") };
context.globalThis = context;
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export class SecurityIntegration", "class SecurityIntegration").replace("export default {", "globalThis.worker = {");
vm.runInNewContext(source, context);
async function api(cookie, path, method = "GET", body) {
  const sessionId = cookie ? JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url")).sessionId : null;
  const request = new Request(`https://example.test/cloud/api${path}`, { method,
    headers: { Origin: "https://example.test", ...(cookie ? { Cookie: cookie, "X-TCloud-Session": sessionId } : {}), "Content-Type": "application/json" },
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
  const a = await handoff("folder-member", "member-a"), b = await handoff("folder-member", "member-b"), admin = await handoff("admin");
  const read = async cookie => { const r = await api(cookie, "/favorites"); assert.equal(r.status,200,JSON.stringify(r.body)); return r.body; };
  const edit = (cookie, body, method="POST") => api(cookie,"/favorites",method,body);
  assert.equal((await api(null,"/favorites")).status,401);
  assert.equal((await edit(a.cookie,{fileIds:[1],folderIds:[8]})).status,200);
  assert.equal((await edit(a.cookie,{fileIds:[1,1],folderIds:[8]})).status,200);
  assert.deepEqual((await read(a.cookie)).files.map(f=>f.id),[1]);
  assert.deepEqual((await read(a.cookie)).folders.map(f=>f.id),[8]);
  assert.equal((await read(b.cookie)).files.length,0);
  assert.equal((await read(admin.cookie)).files.length,0);
  const status=await api(a.cookie,"/favorites/status","POST",{fileIds:[1],folderIds:[8]});
  assert.deepEqual(status.body,{fileIds:[1],folderIds:[8]});
  for(const id of [2,3,4]) assert.ok([403,404,423].includes((await edit(a.cookie,{fileIds:[id]})).status));
  assert.equal((await edit(a.cookie,{folderIds:[9]})).status,403);
  assert.equal((await edit(a.cookie,{fileIds:[1],folderIds:[9]})).status,403);
  assert.equal((await edit(a.cookie,{fileIds:["1"]})).status,400);
  assert.equal((await edit(a.cookie,{fileIds:Array.from({length:101},(_,i)=>i+1)})).status,400);
  // API mutation security is shared with existing endpoints.
  const sessionId=JSON.parse(Buffer.from(a.cookie.split('=')[1].split('.')[0],'base64url')).sessionId;
  for(const headers of [{Cookie:a.cookie,Origin:'https://evil.test','X-TCloud-Session':sessionId},{Cookie:a.cookie,Origin:'https://example.test','X-TCloud-Session':'wrong-tab'}]){
    const r=await context.worker.fetch(new Request('https://example.test/cloud/api/favorites',{method:'POST',headers,body:JSON.stringify({fileIds:[1]})}),env,{waitUntil(){}});
    assert.ok([403,419].includes(r.status));
  }
  assert.equal((await api(a.cookie,"/files/1","PATCH",{name:"renamed.txt",folderId:8})).status,200);
  assert.equal((await api(a.cookie,"/folders/8","PATCH",{name:"renamed folder"})).status,200);
  assert.equal((await read(a.cookie)).files[0].folderId,8);
  assert.equal((await read(a.cookie)).folders[0].name,'renamed folder');
  // A new login/credential on the same service link keeps the durable owner.
  await api(a.cookie,"/logout","POST",{});
  const a2=await handoff("folder-member","member-a");
  assert.notEqual(a2.cookie,a.cookie);
  assert.equal((await read(a2.cookie)).files.length,1);
  assert.equal((await api(admin.cookie,"/files/1","DELETE")).status,200);
  assert.equal((await read(a2.cookie)).files.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cloud_favorite_files').get().n,1);
  assert.equal((await api(admin.cookie,"/files/1/restore","POST",{})).status,200);
  assert.equal((await read(a2.cookie)).files.length,1);
  assert.equal((await api(admin.cookie,"/folders/8","DELETE")).status,200);
  assert.equal((await read(a2.cookie)).folders.length,0);
  assert.equal((await read(a2.cookie)).files.length,0);
  assert.equal((await api(admin.cookie,"/folders/8/restore","POST",{})).status,200);
  assert.equal((await read(a2.cookie)).folders.length,1);
  assert.equal((await edit(a2.cookie,{fileIds:[1],folderIds:[8]},"DELETE")).status,200);
  assert.equal((await read(a2.cookie)).files.length,0);
  assert.equal((await edit(a2.cookie,{fileIds:[1],folderIds:[8]})).status,200);
  // Existing IDs moved outside the root must disappear, without losing records.
  db.exec('UPDATE cloud_files SET folder_id=9 WHERE id=1; UPDATE cloud_folders SET parent_id=9 WHERE id=8');
  assert.equal((await read(a2.cookie)).files.length,0); assert.equal((await read(a2.cookie)).folders.length,0);
  db.exec('UPDATE cloud_files SET folder_id=8 WHERE id=1; UPDATE cloud_folders SET parent_id=7 WHERE id=8');
  assert.equal((await read(a2.cookie)).files.length,1);
  const pw=await api(null,"/login","POST",{loginId:'subadmin@test',authProof:'local-proof'});
  assert.equal(pw.status,200);
  assert.equal((await read(pw.cookie)).files.length,0);
  assert.equal((await edit(pw.cookie,{fileIds:[1]})).status,423);
  await api(pw.cookie,"/folders/7/unlock","POST",{password:'local-proof'});
  assert.equal((await edit(pw.cookie,{fileIds:[1]})).status,200);
  const pw2=await api(null,"/login","POST",{loginId:'subadmin@test',authProof:'local-proof'});
  assert.equal((await read(pw2.cookie)).files.length,0,'PW locks apply to each session');
  await api(pw2.cookie,"/folders/7/unlock","POST",{password:'local-proof'});
  assert.equal((await read(pw2.cookie)).files.length,1,'PW favorites survive login');
  db.exec('UPDATE cloud_folder_unlocks SET expires_at=0');
  assert.equal((await read(pw2.cookie)).files.length,0,'expired unlock hides favorites');
  await edit(admin.cookie,{fileIds:[1],folderIds:[8]});
  assert.equal((await read(admin.cookie)).files.length,1);
  // Foreign keys cover every existing physical-delete path, without new hooks.
  db.exec('PRAGMA foreign_keys=ON; DELETE FROM cloud_files WHERE id=1; DELETE FROM cloud_folders WHERE id=8');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cloud_favorite_files').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cloud_favorite_folders').get().n,0);
  assert.equal(access.length,0,'favorites never read or write video/thumbnail data');
  console.log('PASS favorites migration, batch/idempotency, durable owners, member/PW/passkey separation, scope/PW/CSRF/tab guards, move/rename/trash/restore/cascade');
} finally { db.close(); }
