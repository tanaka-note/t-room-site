import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { context, env as sessionEnv, api, handoff, db as sessionDb } from "./session-fixture.mjs";

const DAY = 86400000;
const admin = { role: "admin", canDelete: true };
function fixture(options = {}, migrated = true) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql") && (migrated || !n.startsWith("0013"))).sort())
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  if (migrated) db.exec("UPDATE cloud_trash_control SET cutover_ready=1 WHERE id=1");
  const hooks = {};
  function statement(sql, args = []) {
    async function execute(kind) {
      if (hooks.before) await hooks.before(sql, kind, args);
      const prepared = db.prepare(sql);
      const value = kind === "first" ? prepared.get(...args) || null
        : kind === "all" ? { results: prepared.all(...args) }
        : (() => { const r = prepared.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; })();
      if (hooks.after) await hooks.after(sql, kind, args, value);
      return value;
    }
    return { bind: (...values) => statement(sql, values), first: () => execute("first"), all: () => execute("all"), run: () => execute("run") };
  }
  const objects = new Map(), deletes = [], heads = [], streamDeletes = [];
  const env = {
    TRASH_CUTOVER_MODE: "ready", TRASH_RETENTION_MODE: "enabled", ...options,
    DB: { prepare: statement, async batch(statements) {
      db.exec("BEGIN");
      try { const results = []; for (const s of statements) results.push(await s.run()); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } },
    FILES: {
      async head(key) { heads.push(key); if (hooks.head) await hooks.head(key); return objects.has(key) ? { size: objects.get(key) } : null; },
      async delete(key) { deletes.push(key); if (hooks.delete) await hooks.delete(key); objects.delete(key); if (hooks.deleted) await hooks.deleted(key); }
    },
    STREAM: { video(uid) { return { async delete() { if (hooks.stream) await hooks.stream(uid); streamDeletes.push(uid); } }; } }
  };
  function folder(id, parent = null) {
    db.prepare("INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(?,?,?,'admin')").run(id, parent, `folder-${id}`);
  }
  function file(id, folderId = null, bytes = 10) {
    db.prepare(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by)
      VALUES(?,?,?,?,'image/jpeg','image',?,'ready','admin')`).run(id, folderId, `originals/${id}`, `photo-${id}`, bytes);
    objects.set(`originals/${id}`, bytes);
  }
  function age(id, days = 30, type = "file") {
    const table = type === "file" ? "cloud_files" : "cloud_folders";
    const row = db.prepare(`SELECT trash_operation_id FROM ${table} WHERE id=?`).get(id);
    const at = new Date(Date.now() - days * DAY).toISOString();
    db.prepare("UPDATE cloud_trash_operations SET deleted_at=? WHERE id=?").run(at, row.trash_operation_id);
    db.prepare("UPDATE cloud_files SET deleted_at=? WHERE trash_operation_id=?").run(at, row.trash_operation_id);
    db.prepare("UPDATE cloud_folders SET deleted_at=? WHERE trash_operation_id=?").run(at, row.trash_operation_id);
  }
  const row = id => db.prepare("SELECT * FROM cloud_files WHERE id=?").get(id);
  const run = () => context.runTrashRetention(env);
  const trash = async (id, days = 30) => { await context.moveFileToTrash(id, env, admin); age(id, days); };
  const restore = id => context.restoreFile(id, env, admin);
  return { db, env, hooks, objects, deletes, heads, streamDeletes, folder, file, age, row, run, trash, restore };
}
function gate() {
  let entered, release;
  const ready = new Promise(r => { entered = r; });
  const wait = new Promise(r => { release = r; });
  return { ready, release, async pause() { entered(); await wait; } };
}
function businessState(db) {
  return JSON.stringify(["cloud_files", "cloud_folders", "cloud_trash_operations", "cloud_trash_purges", "cloud_trash_folder_purges"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
}

test("historical Worker + 0013 reproduces R2 loss before D1 delete guard rejects single/bulk deletion", async () => {
  const historical = readFileSync(new URL("./fixtures/trash-before-0013.js", import.meta.url), "utf8");
  const sandbox = { ...context };
  vm.runInNewContext(historical, sandbox);
  for (const bulk of [false, true]) {
    const f = fixture(); f.file(1);
    f.db.exec("UPDATE cloud_files SET deleted_at=CURRENT_TIMESTAMP WHERE id=1");
    if (bulk) {
      const result = await (await sandbox.emptyTrash(f.env, admin)).json();
      assert.equal(result.failed, 1); assert.equal(result.deleted, 0);
    } else await assert.rejects(sandbox.permanentlyDeleteFile(1, f.env, admin), /trash_purge_not_confirmed/);
    assert.deepEqual(f.deletes, ["originals/1"]);
    assert.equal(f.objects.has("originals/1"), false);
    assert.ok(f.row(1), "old Worker leaves D1 after R2 is already gone");
  }
});

test("new Worker safely pauses before and after 0013 until both acknowledgements are ready", async () => {
  for (const migrated of [false, true]) {
    for (const mode of [undefined, "maintenance", "ready", "invalid"]) {
      const f = fixture({ TRASH_CUTOVER_MODE: mode }, migrated); f.folder(1); f.file(1, 1);
      f.db.exec("UPDATE cloud_files SET deleted_at=CURRENT_TIMESTAMP WHERE id=1");
      if (migrated) f.db.exec("UPDATE cloud_trash_control SET cutover_ready=0");
      for (const call of [
        () => context.permanentlyDeleteFile(1, f.env, admin),
        () => context.emptyTrash(f.env, admin),
        () => context.restoreFile(1, f.env, admin),
        () => context.listTrash(f.env, admin),
        () => context.deleteFolder(1, f.env, admin)
      ]) await assert.rejects(call(), error => error.status === 503);
      assert.deepEqual(f.deletes, []); assert.deepEqual(f.heads, []); assert.ok(f.row(1));
      const status = await context.trashSchemaReadiness(f.env);
      assert.equal(status.schemaReady, migrated); assert.equal(status.cutoverReady, false);
    }
  }
});

test("schema damage/query failure and stopping a previously ready cutover fail closed", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  f.db.exec("DROP TRIGGER cloud_trash_claim_guard");
  await assert.rejects(context.permanentlyDeleteFile(1, f.env, admin), error => error.status === 503);
  assert.deepEqual(f.deletes, []);
  const g = fixture(); g.file(1); await g.trash(1);
  g.hooks.before = sql => { if (sql.includes("SELECT cutover_ready")) throw new Error("D1 unavailable"); };
  assert.equal((await g.run()).reason, "cutover_maintenance"); assert.deepEqual(g.deletes, []);
  g.hooks.before = null; g.db.exec("UPDATE cloud_trash_control SET cutover_ready=0");
  await assert.rejects(g.restore(1), error => error.status === 503);
  assert.deepEqual(g.deletes, []);
});

test("real authenticated HTTP pauses trash operations with 503 while normal reads and status remain available", async () => {
  const login = await handoff("admin");
  const mode = sessionEnv.TRASH_CUTOVER_MODE;
  const before = businessState(sessionDb);
  sessionEnv.TRASH_CUTOVER_MODE = "maintenance";
  try {
    for (const [path, method] of [["/trash", "DELETE"], ["/files/1/permanent", "DELETE"],
      ["/files/1/restore", "POST"], ["/folders/8/restore", "POST"], ["/files/1", "DELETE"],
      ["/folders/8", "DELETE"], ["/trash", "GET"]]) {
      const response = await api(login.cookie, path, method, method === "GET" ? undefined : {},
        { "X-TCloud-Session": login.body.sessionCacheId });
      assert.equal(response.status, 503, `${method} ${path}`);
    }
    assert.equal((await api(login.cookie, "/files/1", "GET", undefined,
      { "X-TCloud-Session": login.body.sessionCacheId })).status, 200);
    const status = await api(null, "/trash-transition-status");
    assert.equal(status.status, 200); assert.equal(status.body.operationsAvailable, false);
    assert.equal(status.body.mode, "maintenance"); assert.equal(status.body.retentionMode, "disabled");
    assert.equal(businessState(sessionDb), before);
  } finally { sessionEnv.TRASH_CUTOVER_MODE = mode; }
});

test("active, 29-day, restored and legacy files are never purged; exactly 720 hours is eligible", async () => {
  const f = fixture();
  for (let id = 1; id <= 5; id++) f.file(id);
  await f.trash(2, 29); await f.trash(3); await f.trash(4); await f.restore(4);
  f.db.prepare("UPDATE cloud_files SET deleted_at=? WHERE id=5").run(new Date(Date.now() - 100 * DAY).toISOString());
  const result = await f.run();
  assert.equal(result.deleted, 1);
  assert.deepEqual(f.deletes, ["originals/3"]);
  for (const id of [1, 2, 4, 5]) assert.ok(f.row(id));
  assert.equal(f.db.prepare("SELECT phase FROM cloud_trash_purges WHERE file_id=3").get().phase, "completed");
});

test("restore and re-trash creates a fresh generation and restarts the deadline", async () => {
  const f = fixture(); f.file(1); await f.trash(1, 90);
  const old = f.row(1).trash_operation_id;
  await f.restore(1); await context.moveFileToTrash(1, f.env, admin);
  assert.notEqual(f.row(1).trash_operation_id, old);
  assert.ok(Date.parse(f.row(1).deleted_at) > Date.now() - 10000);
  assert.equal((await f.run()).deleted, 0); assert.deepEqual(f.deletes, []);
});

test("candidate snapshot -> restoration/re-trash -> claim cannot delete the new generation", async () => {
  for (const retrash of [false, true]) {
    const f = fixture(); f.file(1); await f.trash(1);
    const g = gate();
    f.hooks.after = async (sql, kind) => {
      if (kind === "all" && sql.includes("SELECT f.* FROM cloud_files")) { f.hooks.after = null; await g.pause(); }
    };
    const pending = f.run(); await g.ready; await f.restore(1);
    if (retrash) await context.moveFileToTrash(1, f.env, admin);
    g.release(); const result = await pending;
    assert.equal(result.deleted, 0); assert.equal(result.skipped, 1);
    assert.deepEqual(f.deletes, []); assert.ok(f.row(1));
  }
});

test("claim wins: restoration is rejected before, during and after a partial R2 deletion", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  f.db.prepare("UPDATE cloud_files SET thumbnail_key='thumbnails/1' WHERE id=1").run(); f.objects.set("thumbnails/1", 3);
  const g = gate(); f.hooks.delete = key => key === "originals/1" ? g.pause() : undefined;
  const pending = f.run(); await g.ready;
  await assert.rejects(f.restore(1), /安全確認|trash_/);
  assert.ok(f.row(1).purge_id); g.release(); assert.equal((await pending).deleted, 1);
  assert.deepEqual(f.deletes, ["originals/1", "thumbnails/1"]);
});

test("reserved object/thumbnail/Stream keys cannot be reused even after completion", async () => {
  const f = fixture(); f.file(1); f.file(2); await f.trash(1); await f.run();
  for (const column of ["object_key", "thumbnail_key", "display_thumbnail_key"])
    assert.throws(() => f.db.prepare(`UPDATE cloud_files SET ${column}='originals/1' WHERE id=2`).run(), /trash_key_reserved/);
  assert.throws(() => f.db.prepare("DELETE FROM cloud_trash_purges").run(), /trash_manifest_retain/);
});

test("missing or mismatched operation evidence never becomes automatic trash", async () => {
  const f = fixture(); f.file(1); f.file(2); await f.trash(1); await f.trash(2);
  f.db.exec("UPDATE cloud_files SET trash_operation_id='unknown-operation' WHERE id=1");
  f.db.exec("UPDATE cloud_files SET deleted_at='2001-01-01T00:00:00.000Z' WHERE id=2");
  assert.equal((await f.run()).candidates, 0); assert.deepEqual(f.deletes, []);
});

test("folder restoration wins before claim, including descendants; new trash generation is protected", async () => {
  for (const retrash of [false, true]) {
    const f = fixture(); f.folder(1); f.folder(2, 1); f.file(1, 2);
    await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
    const g = gate(); f.hooks.head = async () => { f.hooks.head = null; await g.pause(); };
    const pending = f.run(); await g.ready;
    await context.restoreFolder(1, f.env, admin);
    if (retrash) await context.deleteFolder(1, f.env, admin);
    g.release(); const result = await pending;
    assert.equal(result.deleted, 0); assert.deepEqual(f.deletes, []);
    assert.ok(f.db.prepare("SELECT * FROM cloud_folders WHERE id=2").get());
  }
});

test("folder restore is atomic and denied for any claimed/deleted descendant", async () => {
  const f = fixture(); f.folder(1); f.folder(2, 1); f.file(1, 1); f.file(2, 2);
  await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
  const g = gate(); f.hooks.delete = async () => { f.hooks.delete = null; await g.pause(); };
  const pending = f.run(); await g.ready;
  const before = businessState(f.db);
  await assert.rejects(context.restoreFolder(1, f.env, admin), /trash_/);
  assert.equal(businessState(f.db), before, "failed restore rolls back every folder and file");
  g.release(); await pending;
});

test("mixed folder generations, restored descendants and non-ready children stop the entire run", async () => {
  for (const anomaly of ["older", "restored", "uploading"]) {
    const f = fixture(); f.folder(1); f.folder(2, 1); f.file(1, 1); f.file(2, 2);
    if (anomaly === "older") await f.trash(2, 50);
    await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
    if (anomaly === "restored") f.db.exec("UPDATE cloud_files SET deleted_at=NULL,trash_operation_id=NULL WHERE id=2");
    if (anomaly === "uploading") f.db.exec("UPDATE cloud_files SET status='uploading' WHERE id=2");
    const result = await f.run();
    assert.equal(result.reason, "inconsistent_folder_tree"); assert.deepEqual(f.deletes, []);
    assert.ok(f.row(1)); assert.ok(f.row(2));
  }
});

test("atomic claim repeats tree validation if corruption occurs after JS preflight", async () => {
  const f = fixture(); f.folder(1); f.file(1, 1); f.file(2, 1);
  await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
  f.hooks.head = () => { f.hooks.head = null; f.db.exec("UPDATE cloud_files SET deleted_at=NULL,trash_operation_id=NULL WHERE id=2"); };
  assert.equal((await f.run()).reason, "state_conflict"); assert.deepEqual(f.deletes, []);
  assert.equal(f.row(1).purge_id, null);
});

test("a folder-only anomaly stops even when there are no eligible leaves or files", async () => {
  const f = fixture(); f.folder(1); f.folder(2, 1);
  await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
  f.db.exec("UPDATE cloud_folders SET deleted_at=NULL,trash_operation_id=NULL WHERE id=2");
  const result = await f.run();
  assert.equal(result.reason, "inconsistent_folder_tree"); assert.equal(result.targetFolderId, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_folders").get().n, 2);
});

test("large nested folder drains in bounded batches; no dangling folders or lost usage totals", async () => {
  const f = fixture({ TRASH_PURGE_MAX_COUNT: "7" }); f.folder(1); f.folder(2, 1);
  for (let id = 1; id <= 61; id++) f.file(id, 2);
  await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
  for (let run = 0; run < 12; run++) {
    const result = await f.run(); assert.equal(result.failed, 0);
    assert.ok(result.deleted + result.deletedFolders <= 7);
  }
  assert.equal(f.deletes.length, 61);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_folders").get().n, 0);
  assert.equal(f.db.prepare("SELECT trash_bytes FROM cloud_usage_summary").get().trash_bytes, 0);
});

test("R2 failure retains D1/manifest, blocks restore and stops before the next file; retry succeeds", async () => {
  const f = fixture(); f.file(1); f.file(2); await f.trash(1); await f.trash(2);
  f.hooks.delete = () => { throw new Error("R2 unavailable"); };
  assert.equal((await f.run()).failed, 1); assert.ok(f.row(1).purge_id); assert.ok(f.row(2));
  await assert.rejects(f.restore(1));
  f.hooks.delete = null;
  assert.equal((await f.run()).deleted, 2);
  assert.deepEqual(f.deletes, ["originals/1", "originals/1", "originals/2"]);
});

test("D1 claim failure leaves R2 untouched and rolls back the manifest/freeze", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  f.hooks.before = sql => { if (sql.includes("SELECT 'trash_purge_claimed'")) throw new Error("D1 write failed"); };
  assert.equal((await f.run()).failed, 1);
  assert.deepEqual(f.deletes, []); assert.equal(f.row(1).purge_id, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_trash_purges").get().n, 0);
  f.hooks.before = null; await f.restore(1);
});

test("D1 finalization failure retains record after objects are gone; retry uses immutable manifest", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  f.hooks.before = sql => { if (sql.startsWith("DELETE FROM cloud_files WHERE id=? AND purge_id")) throw new Error("D1 finalize failed"); };
  assert.equal((await f.run()).failed, 1); assert.ok(f.row(1));
  assert.equal(f.db.prepare("SELECT phase FROM cloud_trash_purges").get().phase, "objects_deleted");
  await assert.rejects(f.restore(1));
  f.hooks.before = null; assert.equal((await f.run()).deleted, 1); assert.deepEqual(f.deletes, ["originals/1"]);
});

test("Worker interruption after object deletion retries after an abandoned lease expires", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  f.hooks.deleted = () => { throw new Error("Worker stopped before D1 acknowledgement"); };
  await f.run(); assert.ok(f.row(1).purge_id); assert.equal(f.objects.size, 0);
  f.db.prepare("UPDATE cloud_trash_control SET lease_owner='stopped-worker',lease_until=?").run(Date.now() + 600000);
  assert.equal((await f.run()).reason, "another_purge_running");
  f.db.exec("UPDATE cloud_trash_control SET lease_until=0"); f.hooks.deleted = null;
  assert.equal((await f.run()).deleted, 1); assert.equal(f.deletes.length, 2);
});

test("overlapping Cron/manual deletion is excluded by the same conditional lease", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  const g = gate(); f.hooks.delete = async () => { f.hooks.delete = null; await g.pause(); };
  const first = f.run(); await g.ready;
  assert.equal((await f.run()).reason, "another_purge_running");
  await assert.rejects(context.permanentlyDeleteFile(1, f.env, admin));
  g.release(); assert.equal((await first).deleted, 1); assert.deepEqual(f.deletes, ["originals/1"]);
});

test("manual deletion has no age requirement, protects live files, and supports legacy trash", async () => {
  const f = fixture({ TRASH_RETENTION_MODE: "disabled" }); f.file(1); f.file(2); f.file(3);
  await context.moveFileToTrash(1, f.env, admin);
  f.db.exec("UPDATE cloud_files SET deleted_at=CURRENT_TIMESTAMP WHERE id=3");
  await context.permanentlyDeleteFile(1, f.env, admin);
  await context.permanentlyDeleteFile(3, f.env, admin);
  await assert.rejects(context.permanentlyDeleteFile(2, f.env, admin));
  assert.deepEqual(f.deletes, ["originals/1", "originals/3"]); assert.ok(f.row(2));
});

test("manual emptyTrash drains nested folders and keeps active/mismatched children intact", async () => {
  const f = fixture(); f.folder(1); f.folder(2, 1); f.file(1, 2);
  await context.deleteFolder(1, f.env, admin);
  let result = await (await context.emptyTrash(f.env, admin)).json();
  assert.equal(result.deleted, 1); assert.equal(result.deletedFolders, 1);
  result = await (await context.emptyTrash(f.env, admin)).json(); assert.equal(result.deletedFolders, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_folders").get().n, 0);
});

test("purging an empty child blocks restoration of the incomplete parent, including legacy trash", async () => {
  for (const legacy of [false, true]) {
    const f = fixture(); f.folder(1); f.folder(2, 1);
    await context.deleteFolder(1, f.env, admin);
    if (legacy) f.db.exec("UPDATE cloud_folders SET trash_operation_id=NULL");
    const result = await (await context.emptyTrash(f.env, admin)).json();
    assert.equal(result.deletedFolders, 1); assert.equal(result.remaining, 1);
    await assert.rejects(context.restoreFolder(1, f.env, admin), /trash_/);
    assert.ok(f.db.prepare("SELECT deleted_at FROM cloud_folders WHERE id=1").get().deleted_at);
  }
});

test("an older completed child purge does not poison a later folder trash/restore generation", async () => {
  for (const childType of ["file", "folder"]) {
    const f = fixture(); f.folder(1);
    if (childType === "file") { f.file(1, 1); await f.trash(1); await f.run(); }
    else { f.folder(2, 1); await context.deleteFolder(2, f.env, admin); await context.emptyTrash(f.env, admin); }
    // Establish a later operation without rewriting any immutable manifest.
    await new Promise(resolve => setTimeout(resolve, 10));
    await context.deleteFolder(1, f.env, admin);
    const listed = await (await context.listTrash(f.env, admin)).json();
    assert.equal(listed.folders[0].purgeStarted, false);
    assert.equal((await context.restoreFolder(1, f.env, admin)).status, 200);
    assert.equal(f.db.prepare("SELECT deleted_at FROM cloud_folders WHERE id=1").get().deleted_at, null);
  }
});

test("manual legacy partial R2 failure cannot report normal restoration", async () => {
  const f = fixture(); f.folder(1); f.file(1, 1);
  f.db.exec("UPDATE cloud_files SET deleted_at=CURRENT_TIMESTAMP,thumbnail_key='thumbnails/1' WHERE id=1");
  f.objects.set("thumbnails/1", 3);
  f.hooks.delete = key => { if (key === "thumbnails/1") throw new Error("thumbnail delete failed"); };
  await assert.rejects(context.permanentlyDeleteFile(1, f.env, admin));
  assert.equal(f.objects.has("originals/1"), false); assert.ok(f.row(1));
  await assert.rejects(f.restore(1));
  const listed = await (await context.listTrash(f.env, admin)).json();
  assert.equal(listed.files[0].purgeStarted, true);
});

test("unexpected failure audit identifies run, target, generation, counts and reason", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  const operationId = f.row(1).trash_operation_id;
  f.hooks.delete = () => { throw new Error("storage unavailable"); };
  const result = await f.run();
  const log = f.db.prepare("SELECT details_json FROM cloud_audit_logs WHERE event_type='trash_run_finished' ORDER BY id DESC LIMIT 1").get();
  const details = JSON.parse(log.details_json);
  assert.equal(details.runId, result.runId); assert.equal(details.operationId, operationId);
  assert.equal(details.targetFileId, 1); assert.equal(details.candidates, 1);
  assert.equal(details.failed, 1); assert.equal(details.deleted, 0); assert.equal(details.bytes, 10);
  assert.equal(details.reason, "d1_or_storage_error"); assert.ok(details.finishedAt);
});

test("count and byte ceilings defer unclaimed records without making them irreversible", async () => {
  const f = fixture({ TRASH_PURGE_MAX_COUNT: "1" }); f.file(1); f.file(2); await f.trash(1); await f.trash(2);
  assert.equal((await f.run()).reason, "count_limit"); assert.ok(f.row(2)); assert.equal(f.row(2).purge_id, null);
  f.env.TRASH_PURGE_MAX_BYTES = "9";
  const result = await f.run(); assert.equal(result.reason, "byte_limit"); assert.equal(result.deleted, 0);
  assert.equal(f.row(2).purge_id, null); await f.restore(2);
});

test("all associated R2 sizes count toward capacity; shared cross-column keys stop deletion", async () => {
  const f = fixture({ TRASH_PURGE_MAX_BYTES: "12" }); f.file(1); f.file(2);
  f.db.exec("UPDATE cloud_files SET thumbnail_key='thumbnails/shared' WHERE id=1"); f.objects.set("thumbnails/shared", 5);
  await f.trash(1); assert.equal((await f.run()).reason, "byte_limit"); assert.equal(f.row(1).purge_id, null);
  f.env.TRASH_PURGE_MAX_BYTES = "100";
  f.db.exec("UPDATE cloud_files SET display_thumbnail_key='thumbnails/shared' WHERE id=2");
  assert.equal((await f.run()).reason, "state_conflict"); assert.deepEqual(f.deletes, []);
});

test("candidate surge, D1 query failure, invalid configuration and emergency stops fail closed", async () => {
  for (const reason of ["ceiling", "growth", "query", "emergency", "envstop", "config"]) {
    const f = fixture({ TRASH_PURGE_MAX_CANDIDATES: "1" }); f.file(1); await f.trash(1);
    if (reason === "ceiling") { f.file(2); await f.trash(2); }
    if (reason === "growth") {
      f.env.TRASH_PURGE_MAX_CANDIDATES = "100"; f.env.TRASH_PURGE_GROWTH_ALLOWANCE = "1";
      f.db.exec("UPDATE cloud_trash_control SET last_candidate_count=0"); f.file(2); await f.trash(2);
    }
    if (reason === "query") f.hooks.before = sql => { if (sql.includes("AS bytes")) throw new Error("D1 query failed"); };
    if (reason === "emergency") f.db.exec("UPDATE cloud_trash_control SET emergency_stop=1");
    if (reason === "envstop") f.env.TRASH_PURGE_EMERGENCY_STOP = "true";
    if (reason === "config") f.env.TRASH_PURGE_MAX_COUNT = "-1";
    assert.equal((await f.run()).failed, 1, reason); assert.deepEqual(f.deletes, [], reason); assert.equal(f.row(1).purge_id, null);
  }
});

test("emergency stop during R2 deletion prevents every subsequent external delete", async () => {
  const f = fixture(); f.file(1); await f.trash(1);
  f.db.exec("UPDATE cloud_files SET thumbnail_key='thumbnails/1' WHERE id=1"); f.objects.set("thumbnails/1", 3);
  f.hooks.deleted = () => f.db.exec("UPDATE cloud_trash_control SET emergency_stop=1");
  assert.equal((await f.run()).reason, "emergency_stop");
  assert.deepEqual(f.deletes, ["originals/1"]); assert.ok(f.row(1)); await assert.rejects(f.restore(1));
});

test("dry-run changes only operational logs/control; no R2/Stream calls, claims or record changes", async () => {
  const f = fixture({ TRASH_RETENTION_MODE: "dry-run" }); f.folder(1); f.folder(2); f.file(1, 1);
  await context.deleteFolder(1, f.env, admin); f.age(1, 31, "folder");
  await context.deleteFolder(2, f.env, admin); f.age(2, 31, "folder");
  const before = businessState(f.db), objects = [...f.objects];
  const result = await f.run(); assert.equal(result.deleted, 0); assert.equal(result.skipped, 3);
  assert.equal(businessState(f.db), before); assert.deepEqual([...f.objects], objects);
  assert.deepEqual(f.deletes, []); assert.deepEqual(f.heads, []); assert.deepEqual(f.streamDeletes, []);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_audit_logs WHERE event_type='trash_dry_run_candidate'").get().n, 3);
});

test("disabled Cron does not require migrated schema or read/write data", async () => {
  let calls = 0;
  await context.runTrashRetention({ TRASH_RETENTION_MODE: "disabled", DB: { prepare() { calls++; throw new Error("unmigrated"); } } });
  assert.equal(calls, 0);
});

test("Stream missing binding blocks before R2; automatic Stream deletion stays fail-closed", async () => {
  const f = fixture(); f.file(1); await f.trash(1); f.db.exec("UPDATE cloud_files SET stream_uid='video' WHERE id=1");
  assert.equal((await f.run()).reason, "stream_unverifiable"); assert.deepEqual(f.deletes, []);
  const stream = f.env.STREAM; delete f.env.STREAM;
  await assert.rejects(context.permanentlyDeleteFile(1, f.env, admin)); assert.deepEqual(f.deletes, []);
  f.env.STREAM = stream; await context.permanentlyDeleteFile(1, f.env, admin); assert.deepEqual(f.streamDeletes, ["video"]);
});

test("real API enforces signed-session permissions on restore/permanent/emptyTrash", async () => {
  const member = await handoff("folder-member", "trash-test-member");
  const sessionId = member.body.sessionCacheId;
  for (const [path, method] of [["/files/1/permanent", "DELETE"], ["/files/1/restore", "POST"], ["/folders/8/restore", "POST"], ["/trash", "DELETE"]]) {
    const response = await api(member.cookie, path, method, {}, { "X-TCloud-Session": sessionId });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.ok(sessionDb.prepare("SELECT id FROM cloud_files WHERE id=1").get());
  assert.equal((await api(null, "/trash", "DELETE", {})).status, 401);
  // UI API returns actual generation/mode and never promises legacy expiry.
  sessionEnv.TRASH_RETENTION_MODE = "dry-run";
  const primary = await handoff("admin");
  const response = await api(primary.cookie, "/trash", "GET", undefined, { "X-TCloud-Session": primary.body.sessionCacheId });
  assert.equal(response.status, 200);
});

test("trash UI labels eligibility, paused modes, legacy protection and irreversible state", () => {
  const client = readFileSync(new URL("../public/cloud.js", import.meta.url), "utf8");
  const source = client.slice(client.indexOf("function trashRetentionLabel("), client.indexOf("function trashFolderCard("));
  const label = vm.runInNewContext(source + ";trashRetentionLabel");
  assert.match(label({}), /対象外/);
  assert.match(label({ purgeStarted: true }), /復元不可/);
  const eligible = { autoDeleteEligibleAt: new Date().toISOString() };
  assert.match(label(eligible), /無効/);
  assert.match(label({ ...eligible, retentionMode: "dry-run" }), /自動削除なし/);
  assert.match(label({ ...eligible, retentionMode: "enabled" }), /次回定期処理/);
});
