import { withPasswordLoginAudit, handlePasswordLoginClientAudit } from "../../assets/security-audit-worker.js";
import { attachPasskeyLedger } from "./passkey-ledger-fixture.mjs";
import { isValidSessionSecret, requireSessionSecret } from "../../assets/session-secret.mjs";
import assert from "node:assert/strict";
import { accountDisplayName } from "../../assets/account-display.mjs";
import { lineBrowserResponse } from "../../assets/line-browser-worker.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { sessionCookieValue, sessionPolicyForAuthMethod, cloudSessionPolicyForAuthMethod, shouldRefreshSession, passwordLifetimeClaims, validSessionLifetime, sessionExpiresAt } from "../../assets/session-policy.mjs";
import { validateServicePasskeySession } from "../../assets/passkey-session-validation.mjs";

globalThis.window = globalThis;
await import("../public/vendor/argon2.umd.min.js");
await import("../public/crypto-vault.js");

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
  return { bind(...values) { return statement(sql, values); }, async first() { return prepared.get(...args) || null; }, async all() { return { results: prepared.all(...args) }; }, async run() { if (prepared.columns().length) return { results: prepared.all(...args) }; const result = prepared.run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; } };
}
let selected;
let revokedScope = null;
const access = [];
const env = { DB: { prepare: statement, async batch(statements) { return Promise.all(statements.map((s) => s.run())); } },
  SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "5", PASSKEY_ENABLED: "true", ACCOUNT_KDF_ID: "test",
  ADMIN_LOGIN_ID: "admin@test", SUBADMIN_LOGIN_ID: "subadmin@test", ADMIN_AUTH_PROOF_HASH: proofHash, SUBADMIN_AUTH_PROOF_HASH: proofHash,
  SECURITY: { async redeemHandoff() { return selected; }, async validatePasskeySession(input) {
    const folderScopes = [{serviceLinkId:"general-user-folder-member",rootFolderId:7},{serviceLinkId:"general-user-nas",rootFolderId:101}];
    const valid = input.serviceAccountId === "admin" ? input.cloudRootFolderId == null
      : input.serviceAccountId === "folder-member" && [7,101].includes(input.cloudRootFolderId)
      && (input.cloudScopeId == null || input.cloudScopeId === "fixture-cloud-scope")
      && (input.folderScopes || (input.cloudScopeId ? folderScopes : [])).every(scope => scope.serviceLinkId !== revokedScope);
    return {valid, ...((input.cloudScopeId || input.folderScopes) && valid ? {folderScopes: input.folderScopes || folderScopes} : {})};
  } },
  FILES: { async createMultipartUpload() { return { uploadId: "fixture-upload" }; }, resumeMultipartUpload() { return { async abort() {}, async uploadPart() { return { partNumber: 1, etag: "fixture" }; } }; }, async get() { access.push("read"); return null; }, async head() { access.push("head"); return null; } }
};
attachPasskeyLedger(env);
const context = { isValidSessionSecret, requireSessionSecret, accountDisplayName, lineBrowserResponse, WorkerEntrypoint: class {}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, atob, btoa, console,
  sessionCookieValue, sessionPolicyForAuthMethod, cloudSessionPolicyForAuthMethod, shouldRefreshSession, passwordLifetimeClaims, validSessionLifetime, sessionExpiresAt, validateServicePasskeySession,
  withPasswordLoginAudit, handlePasswordLoginClientAudit, recordSecurityAudit: async () => {}, enqueueSecurityAudit: () => {}, handleYouTubeSearchRequest: async () => new Response("{}") };
context.globalThis = context;
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export class SecurityIntegration", "class SecurityIntegration").replace("export default {", "globalThis.worker = {");
vm.runInNewContext(source, context);
async function api(cookie, path, method = "GET", body) {
  const sessionId = cookie ? JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url")).sessionId : null;
  const request = new Request(`https://example.test/cloud/api${path}`, { method,
    headers: { Origin: "https://example.test", ...(cookie ? { Cookie: cookie, "X-TCloud-Session": sessionId } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await context.worker.fetch(request, env, { waitUntil() {} });
  return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0], cacheControl: response.headers.get("cache-control") };
}
async function handoff(account, identity = "primary-admin", folderScopes = null, rootFolderId = 7) {
  selected = { identityId: identity, credentialId: "credential", serviceLinkId: `${identity}-${account}`, serviceAccountId: account, cloudRootFolderId: account === "folder-member" ? rootFolderId : null, displayLabel: account === "folder-member" ? "Atsushi" : "管理者", sessionEpoch: 1, ...(folderScopes ? { folderScopes, cloudScopeId: "fixture-cloud-scope" } : {}) };
  const result = await api(null, "/passkey/handoff", "POST", { handoffToken: "fixture" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result;
}
try {
  const admin = await handoff("admin");
  assert.equal((await api(null, "/items?searchCandidates=1")).status, 401);
  const adminCandidates = await api(admin.cookie, "/items?searchCandidates=1");
  assert.equal(adminCandidates.status, 200);
  assert.ok([1, 2, 4].every(id => adminCandidates.body.files.some(file => file.id === id)));
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
    for (const pageSize of [64, 128, 250]) {
      for (const suffix of ["", "&continuation=1&filesOnly=1", "&continuation=1&foldersOnly=1"]) {
        const query = `pageSize=${pageSize}&offset=0${suffix}`;
        for (const [cookie, folderId, expected] of [[null, 7, 401], [member.cookie, 9, 403], [member.cookie, 10, 423], [member.cookie, 99999, 404], [member.cookie, 7, 200]]) {
          const response = await api(cookie, `/items?folderId=${folderId}&${query}`);
          assert.equal(response.status, expected, 'pagination retains session/PW/root checks: ' + query);
          assert.equal(response.cacheControl, 'no-store');
        }
      }
    }
    assert.equal((await api(member.cookie, "/files/4")).status, 423);
    const search = await api(member.cookie, "/items?q=other&recursive=1");
    assert.equal(search.status, 200); assert.equal(search.body.files.some((file) => [2, 3, 4].includes(file.id)), false);
    const candidates = await api(member.cookie, "/items?searchCandidates=1&role=admin");
    assert.equal(candidates.status, 200); assert.ok(candidates.body.files.some(file => file.id === 1));
    assert.equal(candidates.body.files.some(file => [2, 3, 4].includes(file.id)), false);
    assert.equal((await api(member.cookie, "/items?searchCandidates=1&folderId=9")).status, 403);
    assert.equal((await api(member.cookie, "/items?searchCandidates=1&folderId=10")).status, 423);
    assert.equal((await api(member.cookie, "/move-destinations")).body.folders.some((f) => f.id === 9), false);
    assert.equal((await api(member.cookie, "/files/1", "PATCH", { name: "own.txt", folderId: 8 })).status, 200);
    assert.equal((await api(member.cookie, "/files/1", "PATCH", { folderId: 7 })).status, 200);
    assert.equal((await api(member.cookie, "/folders/8", "PATCH", { name: "child" })).status, 200);
    assert.equal((await api(member.cookie, "/folders/10/unlock", "POST", { password: "local-proof" })).status, 200);
    assert.equal((await api(member.cookie, "/files/4")).status, 200);
    assert.ok((await api(member.cookie, "/items?searchCandidates=1")).body.files.some(file => file.id === 4));
    db.prepare("UPDATE cloud_folder_unlocks SET expires_at=0 WHERE folder_id=10").run();
    assert.equal((await api(member.cookie, "/items?searchCandidates=1")).body.files.some(file => file.id === 4), false);
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
  assert.equal(pw.status, 401); assert.equal(pw.cookie, undefined);
  assert.equal((await api(pw.cookie, "/items")).status, 401);
  // Extend the same actual-handler fixture only after the legacy regressions.
  db.prepare("INSERT INTO cloud_folders(id,parent_id,name,password_hash,created_by) VALUES(101,NULL,'NAS',?,'admin'),(102,101,'NAS child',NULL,'admin')").run(proofHash);
  db.exec("INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by) VALUES(100,101,'nas','NAS.txt','text/plain','document',1,'ready','member'); UPDATE cloud_files SET deleted_at=NULL WHERE id=1;");
  const old = await handoff("folder-member", "general-user");
  assert.equal((await api(old.cookie, "/favorites", "POST", {fileIds:[1]})).status, 200);
  const nasOwner = JSON.stringify(["passkey", "general-user", "general-user-nas", "folder-member", "member", 101]);
  db.prepare("INSERT INTO cloud_favorite_files(owner_id,file_id) VALUES(?,100)").run(nasOwner);
  const scopes = [{serviceLinkId:"general-user-folder-member",rootFolderId:7},{serviceLinkId:"general-user-nas",rootFolderId:101}];
  const group = await handoff("folder-member", "general-user", scopes);
  assert.deepEqual(group.body.folderScopes, scopes);
  assert.deepEqual((await api(group.cookie,"/items")).body.folders.map(f=>f.id),[7,101]);
  assert.equal((await api(group.cookie,"/items?folderId=101")).status,200,"delegated protected roots need no folder PW");
  const all = await api(group.cookie,"/items?searchCandidates=1");
  assert.ok([1,100].every(id=>all.body.files.some(file=>file.id===id)));
  assert.ok(!all.body.files.some(file=>[2,3,4].includes(file.id)),"other roots and separately locked children stay excluded");
  assert.deepEqual((await api(group.cookie,"/favorites")).body.files.map(f=>f.id).sort((a,b)=>a-b),[1,100],"both legacy favorite namespaces survive");
  assert.equal((await api(group.cookie,"/favorites","DELETE",{fileIds:[100]})).status,200);
  assert.equal((await api(group.cookie,"/favorites","POST",{fileIds:[100]})).status,200);
  assert.equal(db.prepare("SELECT owner_id FROM cloud_favorite_files WHERE file_id=100").get().owner_id,nasOwner);
  assert.equal((await api(group.cookie,"/files/100","PATCH",{name:"NAS.txt",folderId:102})).status,200);
  assert.equal((await api(group.cookie,"/files/100","PATCH",{folderId:7})).status,200,"cross-root file move is allowed inside the session scope");
  assert.equal(db.prepare("SELECT folder_id FROM cloud_files WHERE id=100").get().folder_id,7);
  assert.equal((await api(group.cookie,"/folders/102","PATCH",{name:"child",parentId:7,parentWrappedKey:"AA",parentWrapIv:"AA"})).status,200,"cross-root folder move is allowed inside the session scope");
  assert.equal((await api(group.cookie,"/folders/101","PATCH",{name:"NAS",parentId:7})).status,403,"assigned root itself cannot move");
  for (const query of ["", "?scopeRootId=101"]) {
    assert.deepEqual((await api(group.cookie,`/move-destinations${query}`)).body.folders.map(f=>f.id).sort((a,b)=>a-b),[7,8,101,102],"picker includes both authorized roots and excludes locked descendants");
  }
  assert.equal((await api(group.cookie,"/move-destinations?scopeRootId=9")).status,403);
  assert.equal((await api(old.cookie,"/files/100","PATCH",{folderId:101})).status,403,"a single-root session cannot move into a later-added scope");
  assert.equal((await api(group.cookie,"/items?folderId=9")).status,403);
  assert.equal((await api(group.cookie,"/files/3")).status,403);
  assert.equal((await api(group.cookie,"/items?folderId=10")).status,423);
  assert.equal((await api(group.cookie,"/session")).body.sessionCacheId,group.body.sessionCacheId,"ordinary folder navigation retains the session");

  // Use real encrypted files/folders and a different recipient vault. Only
  // WebAuthn and the external Security validation are fixture responses.
  const newKey = () => crypto.subtle.generateKey({name:"AES-GCM",length:256},true,["encrypt","decrypt"]);
  const sourceKey = await newKey(), nasKey = await newKey(), folderKey = await newKey();
  const childWrap = await TRoomCrypto.rewrapFolderForParent(folderKey, sourceKey);
  db.prepare(`INSERT INTO cloud_folders(id,parent_id,name,created_by,crypto_version,parent_wrapped_key,parent_wrap_iv)
    VALUES(201,7,'moving folder','admin',1,?,?),(202,201,'descendant','admin',1,?,?)`)
    .run(childWrap.parentWrappedKey,childWrap.parentWrapIv,childWrap.parentWrappedKey,childWrap.parentWrapIv);
  db.prepare("INSERT INTO cloud_folders(id,parent_id,name,created_by,password_hash) VALUES(203,201,'locked descendant','admin',?)").run(proofHash);
  const childKey = await newKey(), nestedWrap = await TRoomCrypto.rewrapFolderForParent(childKey,folderKey);
  db.prepare("UPDATE cloud_folders SET parent_wrapped_key=?,parent_wrap_iv=? WHERE id=202").run(nestedWrap.parentWrappedKey,nestedWrap.parentWrapIv);
  const direct = await TRoomCrypto.createFilePackage({name:"direct.mp4",type:"video/mp4",size:13,lastModified:1},sourceKey,"video");
  const nested = await TRoomCrypto.createFilePackage({name:"nested.mp4",type:"video/mp4",size:13,lastModified:1},childKey,"video");
  const cipher = await TRoomCrypto.encryptFileChunk(direct.fileKey,new TextEncoder().encode("local-content"),0);
  const nestedCipher = await TRoomCrypto.encryptFileChunk(nested.fileKey,new TextEncoder().encode("local-content"),0);
  for (const [id,folderId,encrypted] of [[201,7,direct],[202,202,nested]]) {
    const p = encrypted.payload;
    db.prepare(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by,
      crypto_version,encrypted_metadata,metadata_iv,wrapped_file_key,file_key_iv,encrypted_size_bytes,chunk_size_bytes,chunk_count)
      VALUES(?,?,?,'encrypted','application/octet-stream','video',13,'ready','member',1,?,?,?,?,?,?,?)`)
      .run(id,folderId,`local-encrypted-${id}`,p.encryptedMetadata,p.metadataIv,p.wrappedFileKey,p.fileKeyIv,p.encryptedSizeBytes,p.chunkSizeBytes,p.chunkCount);
  }
  const recipient = await handoff("folder-member","nas-recipient",null,101);
  const recipientPrf = crypto.getRandomValues(new Uint8Array(32));
  const recipientVault = await TRoomCrypto.createPasskeyClientVault(recipientPrf);
  const nasEnvelope = await TRoomCrypto.wrapFolderKeyForIdentity(nasKey,recipientVault.publicKeyJwk);
  const recipientPrivate = await TRoomCrypto.unlockPasskeyClientPrivateKey(recipientPrf,recipientVault);
  const recipientNasKey = await TRoomCrypto.unlockDelegatedFolderKey(recipientPrivate,nasEnvelope);
  const shared = await TRoomCrypto.createSharePackage(direct.fileKey,"local-shared-file-password");
  assert.equal((await api(group.cookie,"/favorites","POST",{fileIds:[201,202],folderIds:[201,202]})).status,200);
  const movingFileWrap = await TRoomCrypto.rewrapFileForFolder(direct.fileKey,nasKey);
  assert.equal((await api(old.cookie,"/files/201","PATCH",{folderId:101,...movingFileWrap})).status,403);
  assert.equal((await api(group.cookie,"/files/201","PATCH",{folderId:101,...movingFileWrap})).status,200);
  const recipientFile = await api(recipient.cookie,"/files/201");
  assert.equal(recipientFile.status,200);
  const recipientFileKey = await TRoomCrypto.unlockFileKey(recipientFile.body.file,recipientNasKey);
  assert.equal(new TextDecoder().decode(await TRoomCrypto.decryptFileChunk(recipientFileKey,cipher,0)),"local-content");
  assert.equal((await api(old.cookie,"/files/201")).status,403,"source-only member loses ordinary access");
  const shareKey = await TRoomCrypto.unlockShareKey(shared,"local-shared-file-password");
  assert.equal(new TextDecoder().decode(await TRoomCrypto.decryptFileChunk(shareKey.targetKey,cipher,0)),"local-content","existing file-share key remains valid");
  assert.equal((await context.requireSharedFile(env,{id:999,target_type:"file",target_id:201},201)).id,201,"direct share follows the stable file ID");
  assert.equal((await api(recipient.cookie,"/favorites")).body.files.length,0,"sharing a destination does not share another Identity's favorites");
  const movedFolderWrap = await TRoomCrypto.rewrapFolderForParent(folderKey,nasKey);
  assert.equal((await api(group.cookie,"/folders/201","PATCH",{name:"moving folder",parentId:202,...movedFolderWrap})).status,400,"self descendants remain invalid destinations");
  assert.equal((await api(group.cookie,"/folders/201","PATCH",{name:"moving folder",parentId:10,...movedFolderWrap})).status,423,"destination PW must be unlocked");
  assert.equal((await api(group.cookie,"/folders/203","PATCH",{name:"locked descendant",parentId:101,...movedFolderWrap})).status,423,"source PW must be unlocked");
  assert.equal((await api(group.cookie,"/folders/201","PATCH",{name:"moving folder",parentId:101,...movedFolderWrap})).status,200);
  const destinationListing = await api(recipient.cookie,"/items?folderId=201");
  assert.equal(destinationListing.status,200,"destination member may operate moved folders");
  const movedParentKey = await TRoomCrypto.unlockFolderFromParent(await context.requireFolder(env,201),recipientNasKey);
  const movedChildKey = await TRoomCrypto.unlockFolderFromParent(await context.requireFolder(env,202),movedParentKey);
  const nestedRecord = await api(recipient.cookie,"/files/202");
  assert.equal(nestedRecord.status,200);
  const nestedFileKey = await TRoomCrypto.unlockFileKey(nestedRecord.body.file,movedChildKey);
  assert.equal(new TextDecoder().decode(await TRoomCrypto.decryptFileChunk(nestedFileKey,nestedCipher,0)),"local-content");
  assert.equal((await api(recipient.cookie,"/folders/202","PATCH",{name:"recipient rename"})).status,200);
  assert.equal((await api(recipient.cookie,"/items?folderId=203")).status,423,"moving an ancestor does not unlock protected descendants");
  assert.equal((await api(old.cookie,"/items?folderId=201")).status,403);
  const destinationOnly = await handoff("folder-member","general-user",null,101);
  assert.deepEqual((await api(destinationOnly.cookie,"/favorites")).body.files.map(f=>f.id).sort((a,b)=>a-b),[201,202],"favorites remain visible through destination-only scope");
  assert.deepEqual((await api(destinationOnly.cookie,"/favorites")).body.folders.map(f=>f.id).sort((a,b)=>a-b),[201,202]);
  assert.deepEqual((await api(destinationOnly.cookie,"/favorites/status","POST",{fileIds:[201,202],folderIds:[201]})).body,{fileIds:[201,202],folderIds:[201]});
  assert.equal((await api(old.cookie,"/favorites")).body.files.some(f=>[201,202].includes(f.id)),false,"old favorite records do not bypass scope");
  assert.equal((await api(destinationOnly.cookie,"/favorites","DELETE",{fileIds:[201],folderIds:[201]})).status,200);
  assert.equal((await api(destinationOnly.cookie,"/favorites/status","POST",{fileIds:[201],folderIds:[201]})).body.fileIds.length,0);
  assert.equal(access.length,0,"moves and permission/favorite checks never transfer file bodies through R2");
  revokedScope="general-user-nas";
  assert.equal((await api(group.cookie,"/items")).status,401,"non-anchor link revoke rejects the next request");
  assert.equal((await api(group.cookie,"/files/100","PATCH",{folderId:101})).status,401,"revocation also blocks moves before mutation");
  assert.equal((await api(old.cookie,"/items")).status,200,"an old single-root session is not widened");
  console.log("member API boundary: scope/PW/revocation guards, encrypted cross-root file/subtree moves, recipient access, stable shares and private favorites passed");
} finally { db.close(); }
