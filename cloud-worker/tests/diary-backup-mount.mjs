import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { scanBackupMetadata, getBackupSnapshot } from "../../diary-worker/src/backup-browser.js";

const at = new Date("2026-09-12T18:25:00Z");
const objects = [
  { key: "daily/2026-09-13.json.gz", size: 101, uploaded: at, customMetadata: { format: "troom-diary-d1-v4", mediaComplete: "true" } },
  { key: "daily/2026-09-12.json.gz", size: 99, uploaded: new Date(at - 86400000), customMetadata: {} },
  { key: "monthly/2026-09.json.gz", size: 80, uploaded: at, customMetadata: { mediaComplete: "false" } },
  { key: "media/formal-photos/one/original", size: 1000, uploaded: at },
  { key: "media/formal-photos/one/thumbnail", size: 20, uploaded: at },
  { key: "unrelated/ignored", size: 999999, uploaded: at }
];
let listCalls = 0;
// A read-only fixture intentionally has no get, put, delete, copy or body APIs.
const bucket = { async list({ prefix, cursor, include }) {
  listCalls++;
  if (prefix !== "media/formal-photos/") assert.deepEqual(include, ["customMetadata", "httpMetadata"]);
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
  const env = { DB: { prepare: statement }, DIARY_BACKUP_MOUNT_FOLDER_ID: "2850", DIARY_BACKUPS: { async getSnapshot() { return snapshot; } } };
  const context = { WorkerEntrypoint: class {}, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto, atob, btoa, console, setTimeout, clearTimeout, enqueueSecurityAudit() {} };
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export class SecurityIntegration", "class SecurityIntegration").replace("export default {", "globalThis.worker = {");
  vm.runInNewContext(source, context);
  // Isolate the authenticated API boundary; existing member-api-boundary tests
  // exercise the real signed-session and passkey validation separately.
  vm.runInNewContext("readSession = async () => fixtureSession", context);
  return { env, db, async api(path, role = "admin", method = "GET") {
    context.fixtureSession = role ? { role, sessionId: "local-fixture", canDelete: role === "admin", canUpload: true, authMethod: "password" } : null;
    const url = new URL(`https://example.test/cloud/api${path}`);
    const response = await context.handleApi(new Request(url, { method, headers: { Origin: url.origin } }), env, url, url.pathname.slice(6), {});
    return { status: response.status, body: await response.json() };
  } };
}

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

test("anonymous, member and subadmin cannot access backup metadata", async () => {
  const f = fixture();
  try {
    for (const role of [null, "member", "subadmin"]) await assert.rejects(f.api("/diary-backups", role), e => e.status === (role ? 403 : 401));
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
  } finally { f.db.close(); }
});

test("upload/delete/move/rename/share are rejected at the virtual boundary", async () => {
  const f = fixture();
  try {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) await assert.rejects(f.api("/diary-backups", "admin", method), e => e.status === 405);
    for (const action of ["move", "share", "upload", "trash"]) await assert.rejects(f.api(`/diary-backups/${action}`, "admin", "POST"), e => e.status === 405);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_files").get().n, 2);
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(config.r2_buckets.some(b => b.bucket_name === "t-room-diary-backups"), false);
  } finally { f.db.close(); }
});
