import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { isValidSessionSecret, requireSessionSecret } from "../../assets/session-secret.mjs";
import { scanBackupMetadata, getBackupSnapshot } from "../../diary-worker/src/backup-browser.js";

const at = new Date("2026-09-12T18:25:00Z");
const objects = [
  { key: "v7/daily/2026-09-13.json.gz", size: 101, uploaded: at, customMetadata: { format: "troom-diary-d1-v4", mediaComplete: "true" } },
  { key: "v7/daily/2026-09-12.json.gz", size: 99, uploaded: new Date(at - 86400000), customMetadata: {} },
  { key: "v7/monthly/2026-09.json.gz", size: 80, uploaded: at, customMetadata: { mediaComplete: "false" } },
  { key: "media/verified-photos/one/original", size: 1000, uploaded: at },
  { key: "media/verified-photos/one/thumbnail", size: 20, uploaded: at },
  { key: "unrelated/ignored", size: 999999, uploaded: at }
];
let listCalls = 0;
// A read-only fixture intentionally has no get, put, delete, copy or body APIs.
const bucket = { async list({ prefix, cursor, include }) {
  listCalls++;
  if (!["media/verified-photos/","media/photo-receipts/","media/formal-photos/"].includes(prefix)) assert.deepEqual(include, ["customMetadata", "httpMetadata"]);
  const selected = objects.filter(o => o.key.startsWith(prefix));
  const offset = Number(cursor || 0);
  return { objects: selected.slice(offset, offset + 1), truncated: offset + 1 < selected.length, cursor: String(offset + 1) };
} };
const snapshot = await scanBackupMetadata(bucket);

test("the JavaScript and CSS actually served by the Worker match the source", () => {
  for (const [source, served] of [["cloud.js", "cloud-runtime-20260816-1.js"], ["cloud.css", "cloud-runtime-20260815-1.css"]]) {
    assert.equal(readFileSync(new URL(`../public/${served}`, import.meta.url), "utf8"), readFileSync(new URL(`../public/${source}`, import.meta.url), "utf8"));
  }
});

test("real R2 sizes, pagination, metadata and photo overview without copying", () => {
  assert.equal(snapshot.backupBytes, 1300);
  assert.equal(snapshot.backupObjectCount, 5);
  assert.equal(snapshot.daily.objectCount, 2);
  assert.equal(snapshot.monthly.objectCount, 1);
  assert.equal(snapshot.photo.bytes, 1020);
  assert.equal(snapshot.photo.objectCount, 2);
  assert.equal(snapshot.photo.objects, undefined);
  assert.equal(snapshot.mediaComplete, true);
  assert.equal(snapshot.lastBackupAt, at.toISOString());
  assert.equal(snapshot.daily.objects[1].mediaComplete, null);
  assert.equal(snapshot.monthly.objects[0].mediaComplete, false);
});

test("snapshot cache avoids repeated LIST; explicit refresh rescans after cooldown", async () => {
  let stored;
  const cache = { async match() { return stored ? new Response(stored) : undefined; }, async put(_key, response) { stored = await response.text(); } };
  await getBackupSnapshot({ BACKUP: bucket }, {}, cache);
  const calls = listCalls;
  await getBackupSnapshot({ BACKUP: bucket }, {}, cache);
  await getBackupSnapshot({ BACKUP: bucket }, { refresh: true }, cache);
  assert.equal(listCalls, calls);
  stored = JSON.stringify({ ...JSON.parse(stored), observedAt: new Date(Date.now() - 61000).toISOString() });
  await getBackupSnapshot({ BACKUP: bucket }, { refresh: true }, cache);
  assert.ok(listCalls > calls);
});

test("incomplete pagination fails instead of reporting a partial total", async () => {
  await assert.rejects(scanBackupMetadata({ async list() { return { objects: [], truncated: true }; } }));
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.exec("INSERT INTO cloud_folders(id,name,created_by) VALUES(2850,'renamed backup entrance','admin'),(7,'ordinary','admin');");
  db.exec("INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by) VALUES(1,2850,'existing','existing.txt','text/plain','document',60,'ready','admin'),(2,7,'normal','normal.txt','text/plain','document',40,'ready','admin');");
  function statement(sql, args = []) {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/i, "mount requests must not write D1");
    const prepared = db.prepare(sql);
    return { bind(...values) { return statement(sql, values); }, async first() { return prepared.get(...args) || null; }, async all() { return { results: prepared.all(...args) }; } };
  }
  let snapshotCalls = 0;
  const env = { DB: { prepare: statement, async batch(statements) { return Promise.all(statements.map(s => s.all())); } }, SESSION_SECRET: randomBytes(32).toString("hex"), DIARY_BACKUP_MOUNT_FOLDER_ID: "2850", DIARY_BACKUPS: { async getSnapshot() { snapshotCalls++; return snapshot; } } };
  const context = { isValidSessionSecret, requireSessionSecret, WorkerEntrypoint: class {}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, atob, btoa, console, setTimeout, clearTimeout, enqueueSecurityAudit() {} };
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export class SecurityIntegration", "class SecurityIntegration").replace("export default {", "globalThis.worker = {");
  vm.runInNewContext(source, context);
  // Isolate the authenticated API boundary; existing member-api-boundary tests
  // exercise the real signed-session and passkey validation separately.
  vm.runInNewContext("readSession = async () => fixtureSession", context);
  return { env, db, get snapshotCalls() { return snapshotCalls; }, async api(path, role = "admin", method = "GET", claims = {}) {
    context.fixtureSession = role ? { ...claims, role, sessionId: "local-fixture", canDelete: role === "admin", canUpload: true, authMethod: "password" } : null;
    const url = new URL(`https://example.test/cloud/api${path}`);
    const response = await context.handleApi(new Request(url, { method, headers: { Origin: url.origin } }), env, url, url.pathname.slice(6), {});
    return { status: response.status, body: await response.json() };
  } };
}

test('authorized members and admins share service failures, history and partial diary outages', async () => {
  const f = fixture();
  try {
    f.env.SERVICE_BACKUPS = { async getSnapshot() { return { backupBytes: 200, services: [{ id: 'health', label: '体調管理', state: 'failed', available: true, history: [{ state: 'failed', reason: 'operation_failed' }] }] }; } };
    const result = (await f.api('/diary-backups')).body;
    assert.equal(result.backupBytes, 1500);
    assert.equal(result.diaryBytes, 1300);
    assert.equal(result.services[0].state, 'failed');
    assert.deepEqual((await f.api('/diary-backups', 'member', 'GET', member())).body, result);
    f.env.DIARY_BACKUPS.getSnapshot = async () => { throw new Error('Unavailable'); };
    const partial = (await f.api('/diary-backups')).body;
    assert.equal(partial.available, true);
    assert.equal(partial.diaryAvailable, false);
    assert.equal(partial.backupBytes, 200);
    assert.deepEqual((await f.api('/diary-backups', 'member', 'GET', member())).body, partial);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cloud_files').get().n, 2);
  } finally { f.db.close(); }
});

test("admin reads the fixed mount ID despite rename, with actual metadata", async () => {
  const f = fixture();
  try {
    const r = await f.api("/diary-backups");
    assert.equal(r.status, 200);
    assert.equal(r.body.folderId, 2850);
    assert.equal(r.body.readOnly, true);
    assert.equal(r.body.backupBytes, 1300);
  } finally { f.db.close(); }
});

test("backup metadata retains the real session-secret preflight", async () => {
  const f = fixture();
  try {
    for (const value of [undefined, "invalid"]) {
      f.env.SESSION_SECRET = value;
      await assert.rejects(f.api("/diary-backups"), error => error.status === 503);
    }
  } finally { f.db.close(); }
});

test("anonymous, unassigned member and retired subadmin cannot access backup metadata", async () => {
  const f = fixture();
  try {
    for (const role of [null, "member", "subadmin"]) await assert.rejects(f.api("/diary-backups", role), e => e.status === (role ? 403 : 401));
  } finally { f.db.close(); }
});


const member = (rootFolderId = 2850, extra = {}) => ({ rootFolderId, serviceLinkId: "fixture-link", ...extra });

test("delegated members receive the same metadata and mount marker as admin", async () => {
  const f = fixture();
  try {
    const admin = (await f.api("/diary-backups")).body;
    for (const identityId of ["ordinary-one", "ordinary-two"]) {
      const claims = member(2850, { identityId });
      assert.deepEqual((await f.api("/diary-backups", "member", "GET", claims)).body, admin);
      const listing = (await f.api("/items?folderId=2850", "member", "GET", claims)).body;
      assert.deepEqual(listing.backupMount, { type: "diary-backup", folderId: 2850 });
      assert.equal(listing.files[0].id, 1);
      for (const path of ["/usage", "/usage-details"]) {
        await assert.rejects(f.api(path, "member", "GET", claims), e => e.status === 403);
      }
    }
    const claims = member(7, { folderScopes: [{ serviceLinkId: "one", rootFolderId: 7 }, { serviceLinkId: "two", rootFolderId: 2850 }] });
    assert.equal((await f.api("/diary-backups?refresh=1", "member", "GET", claims)).status, 200);
  } finally { f.db.close(); }
});

test("unrelated/child-only scopes and arbitrary client folder IDs cannot authorize the mount", async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(2851,2850,'child','admin')");
    for (const claims of [{}, member(7), member(2851)]) {
      for (const path of ["/diary-backups", "/diary-backups?folderId=7&role=admin", "/items?folderId=2850"]) {
        await assert.rejects(f.api(path, "member", "GET", claims), e => e.status === 403, path);
      }
    }
    assert.equal(f.snapshotCalls, 0, "denied requests never call the backup service");
  } finally { f.db.close(); }
});

test("nested mount evaluates every lock below the nearest delegated root on each request", async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO cloud_folders(id,parent_id,name,password_hash,created_by) VALUES(20,7,'protected ancestor','fixture','admin'); UPDATE cloud_folders SET parent_id=20,password_hash='fixture' WHERE id=2850;");
    const claims = member(7);
    const read = path => f.api(path, "member", "GET", claims);
    for (const path of ["/diary-backups", "/items?folderId=2850"]) await assert.rejects(read(path), e => e.status === 423);
    f.db.prepare("INSERT INTO cloud_folder_unlocks(session_id,folder_id,expires_at) VALUES('local-fixture',2850,?)").run(Math.floor(Date.now()/1000)+60);
    await assert.rejects(read("/diary-backups"), e => e.status === 423, "ancestor must also be unlocked");
    f.db.prepare("INSERT INTO cloud_folder_unlocks(session_id,folder_id,expires_at) VALUES('local-fixture',20,?)").run(Math.floor(Date.now()/1000)+60);
    assert.equal((await read("/diary-backups")).status, 200);
    assert.equal((await read("/items?folderId=2850")).body.backupMount.folderId, 2850);
    f.db.exec("UPDATE cloud_folder_unlocks SET expires_at=0");
    await assert.rejects(read("/diary-backups"), e => e.status === 423);
    // A directly delegated protected root uses its existing key envelope policy.
    assert.equal((await f.api("/diary-backups", "member", "GET", member())).status, 200);
    f.db.exec("UPDATE cloud_folders SET parent_id=NULL WHERE id=2850");
    await assert.rejects(read("/diary-backups"), e => e.status === 403, "moving out of scope revokes the next request");
    f.db.exec("UPDATE cloud_folders SET deleted_at=CURRENT_TIMESTAMP WHERE id=2850");
    await assert.rejects(f.api("/diary-backups", "member", "GET", member()), e => e.status === 403);
  } finally { f.db.close(); }
});

test("normal listing is preserved; virtual mount stays outside files/folders", async () => {
  const f = fixture();
  try {
    const root = (await f.api("/items")).body;
    assert.equal(root.folders.length, 2);
    const listing = (await f.api("/items?folderId=2850")).body;
    assert.equal(listing.files[0].id, 1);
    assert.equal(listing.folders.length, 0);
    assert.equal(listing.backupMount.type, "diary-backup");
    const sub = (await f.api("/items?folderId=2850", "subadmin")).body;
    assert.equal(sub.backupMount, null);
  } finally { f.db.close(); }
});

test("usage adds backupBytes once; details preserve ordinary files inside Backup-data", async () => {
  const f = fixture();
  try {
    const usage = (await f.api("/usage")).body;
    assert.equal(usage.cloudBytes, 100);
    assert.equal(usage.backupBytes, 1300);
    assert.equal(usage.activeBytes, 1400);
    assert.equal(usage.activeFileCount, 2);
    assert.equal(usage.trashBytes, 0);
    const details = (await f.api("/usage-details")).body;
    assert.equal(details.folders.find(o => o.id === 2850).sizeBytes, 1360);
    assert.equal(details.backup.photo.bytes, 1020);
  } finally { f.db.close(); }
});

test("backup outage preserves normal usage and files", async () => {
  const f = fixture();
  try {
    f.env.DIARY_BACKUPS.getSnapshot = async () => { throw new Error("unavailable"); };
    const usage = (await f.api("/usage")).body;
    assert.equal(usage.activeBytes, 100);
    assert.equal(usage.backupBytes, null);
    assert.equal(usage.backupAvailable, false);
    assert.equal((await f.api("/diary-backups")).status, 503);
    assert.equal((await f.api("/items?folderId=7")).body.files.length, 1);
    assert.equal((await f.api("/diary-backups", "member", "GET", member())).status, 503);
    assert.equal((await f.api("/items?folderId=2850", "member", "GET", member())).body.files[0].id, 1);
  } finally { f.db.close(); }
});

test("upload/delete/move/rename/share are rejected at the virtual boundary", async () => {
  const f = fixture();
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await assert.rejects(f.api("/diary-backups", "member", method, member()), e => e.status === 405);
    }
    for (const action of ["download", "restore", "delete", "move", "share"]) {
      await assert.rejects(f.api(`/diary-backups/${action}`, "member", "GET", member()), e => e.status === 405);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) await assert.rejects(f.api("/diary-backups", "admin", method), e => e.status === 405);
    for (const action of ["move", "share", "upload", "trash"]) await assert.rejects(f.api(`/diary-backups/${action}`, "admin", "POST"), e => e.status === 405);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_files").get().n, 2);
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(config.r2_buckets.some(b => b.bucket_name === "t-room-diary-backups"), false);
  } finally { f.db.close(); }
});

test("actual Cloud/Security handlers validate signed member sessions and reject revocation before snapshot access", async () => {
  const { env, context, api, handoff, db, securityDb, legacyPasswordSession } = await import("./session-fixture.mjs");
  const { attachPasskeyLedger, seedMultiFolderHandoff } = await import("./passkey-ledger-fixture.mjs");
  context.setTimeout = setTimeout; context.clearTimeout = clearTimeout;
  env.DIARY_BACKUP_MOUNT_FOLDER_ID = "9";
  let reads = 0;
  env.DIARY_BACKUPS = { async getSnapshot() { reads++; return snapshot; } };
  env.SERVICE_BACKUPS = { async getSnapshot() { reads++; return { backupBytes: 200, services: [{ id: "billing", state: "failed", history: [{ state: "failed", reason: "operation_failed" }] }] }; } };
  try {
    const admin = await handoff("admin");
    const adminBackup = await api(admin.cookie, "/diary-backups", "GET", undefined, { "X-TCloud-Session": admin.body.sessionCacheId });
    assert.equal(adminBackup.status, 200);
    assert.equal(adminBackup.body.backupBytes, 1500);
    assert.equal(adminBackup.body.services[0].history[0].reason, "operation_failed");
    assert.equal((await api(null, "/diary-backups")).status, 401);
    assert.equal((await api(legacyPasswordSession("admin").cookie, "/diary-backups")).status, 401);
    for (const identity of ["primary-admin", "another-member"]) {
      const ledger = attachPasskeyLedger(env, { realValidation: true });
      try {
        seedMultiFolderHandoff(ledger);
        if (identity !== "primary-admin") {
          ledger.prepare("INSERT INTO security_identities(id,display_name,status) VALUES(?,'Another member','active')").run(identity);
          for (const table of ["security_credentials", "security_tcloud_client_vaults", "security_service_links", "security_tcloud_key_envelopes", "security_handoffs"]) {
            ledger.prepare(`UPDATE ${table} SET identity_id=?`).run(identity);
          }
        }
        const login = await api(null, "/passkey/handoff", "POST", { handoffToken: "cloud-member" });
        assert.equal(login.status, 200, JSON.stringify(login.body));
        assert.equal(login.body.role, "member");
        const headers = { "X-TCloud-Session": login.body.sessionCacheId };
        const read = (path, cookie = login.cookie, extra = headers) => api(cookie, path, "GET", undefined, extra);
        assert.deepEqual((await read("/diary-backups")).body, adminBackup.body);
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          assert.equal((await api(login.cookie, "/diary-backups", method, {}, headers)).status, 405);
        }
        for (const action of ["download", "restore", "move", "share", "delete"]) {
          assert.equal((await read(`/diary-backups/${action}`)).status, 405);
        }
        assert.equal((await read("/items?folderId=9")).body.backupMount.folderId, 9);
        assert.equal((await read("/diary-backups", login.cookie, {})).status, 419);
        assert.equal((await read("/diary-backups", login.cookie, { "X-TCloud-Session": "wrong-tab" })).status, 419);
        const [payload, signature] = login.cookie.split("=")[1].split(".");
        const tampered = `troom_cloud_session=${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
        assert.equal((await read("/diary-backups", tampered)).status, 401);
        for (const path of ["/usage", "/usage-details"]) assert.equal((await read(path)).status, 403);
        env.DIARY_BACKUP_MOUNT_FOLDER_ID = "10";
        assert.equal((await read("/diary-backups")).status, 423, "locked descendant uses real session ID");
        env.DIARY_BACKUP_MOUNT_FOLDER_ID = "11";
        assert.equal((await read("/diary-backups")).status, 423, "locked ancestor remains enforced");
        env.DIARY_BACKUP_MOUNT_FOLDER_ID = "99999";
        assert.equal((await read("/diary-backups?folderId=9")).status, 403);
        env.DIARY_BACKUP_MOUNT_FOLDER_ID = "9";
        const beforeRevoke = reads;
        ledger.exec("UPDATE security_service_links SET status='disabled' WHERE id='primary-admin-second'");
        assert.equal((await read("/diary-backups")).status, 401, "non-anchor link revocation rejects the very next request");
        assert.equal(reads, beforeRevoke, "no backup RPC after session/scope revocation");
      } finally { ledger.close(); }
    }
  } finally { db.close(); securityDb.close(); }
});
