// Local workerd / D1 / R2 only. No production bindings or credentials.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const productionVars = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).vars;
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export default {", "const applicationWorker = {");
const script = `import { WorkerEntrypoint } from "cloudflare:workers";
  ${source}
  export default { async fetch(request, env) {
    const url = new URL(request.url), admin = { role: "admin", canDelete: true };
    const id = Number(url.searchParams.get("id"));
    try {
      if (url.pathname === "/status") return Response.json(await trashSchemaReadiness(env));
      if (url.pathname === "/empty") return await emptyTrash(env, admin);
      if (url.pathname === "/trash") return await moveFileToTrash(id, env, admin);
      if (url.pathname === "/restore") return await restoreFile(id, env, admin);
      if (url.pathname === "/trash-folder") return await deleteFolder(id, env, admin);
      if (url.pathname === "/restore-folder") return await restoreFolder(id, env, admin);
      if (url.pathname === "/dry-run") return Response.json(await runTrashRetention({ ...env, TRASH_RETENTION_MODE: "dry-run" }));
      if (url.pathname === "/limited-run") return Response.json(await runTrashRetention({ ...env, TRASH_PURGE_MAX_BYTES: "8" }));
      return Response.json(await runTrashRetention(env));
    } catch (error) { return new Response("conflict", { status: error.status || 409 }); }
  } };
`;
function migrationStatements(sql) {
  const statements = [];
  let buffer = "";
  for (const line of sql.replace(/--[^\n]*/g, "").split("\n")) {
    buffer += line + "\n";
    const trimmed = buffer.trim();
    if (trimmed.endsWith(";") && (!/^CREATE TRIGGER/i.test(trimmed) || /END;$/i.test(trimmed))) {
      statements.push(trimmed); buffer = "";
    }
  }
  assert.equal(buffer.trim(), "");
  return statements;
}

test("workerd: Worker-first cutover preserves R2 on old schema and while migration is unacknowledged", async () => {
  const mf = new Miniflare((convertV4MiniflareOptions || (options => options))({ workers: [{ modules: true, script,
    compatibilityDate: "2026-08-01", d1Databases: ["DB"], r2Buckets: ["FILES"],
    bindings: { TRASH_RETENTION_MODE: "disabled", TRASH_CUTOVER_MODE: "ready" } }] }));
  try {
    const db = await mf.getD1Database("DB"), r2 = await mf.getR2Bucket("FILES");
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort();
    const apply = async name => { for (const sql of migrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))) await db.prepare(sql).run(); };
    for (const name of names.filter(n => !n.startsWith("0013"))) await apply(name);
    await db.prepare(`INSERT INTO cloud_files(id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by,deleted_at)
      VALUES(1,'originals/cutover','fixture','image/jpeg','image',4,'ready','admin',CURRENT_TIMESTAMP)`).run();
    await r2.put("originals/cutover", "test");
    const call = path => mf.dispatchFetch(`http://fixture.test${path}`);
    assert.equal((await call("/empty")).status, 503);
    assert.equal((await (await call("/status")).json()).schemaReady, false);
    assert.ok(await r2.head("originals/cutover"));
    await apply(names.find(n => n.startsWith("0013")));
    assert.equal((await call("/empty")).status, 503);
    const status = await (await call("/status")).json();
    assert.equal(status.schemaReady, true); assert.equal(status.cutoverReady, false);
    assert.ok(await r2.head("originals/cutover"));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_trash_purges").first()).n, 0);
    await db.prepare("UPDATE cloud_trash_control SET cutover_ready=1 WHERE id=1").run();
    assert.equal((await call("/empty")).status, 200);
    assert.equal(await r2.head("originals/cutover"), null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_files").first()).n, 0);
  } finally { await mf.dispose(); }
});

test("workerd: production activation after two dry-runs deletes only expired verified trash and preserves other R2 data", async () => {
  const mf = new Miniflare((convertV4MiniflareOptions || (options => options))({ workers: [{ modules: true, script,
    compatibilityDate: "2026-08-01", d1Databases: ["DB"], r2Buckets: ["FILES"], bindings: productionVars }] }));
  try {
    const db = await mf.getD1Database("DB"), r2 = await mf.getR2Bucket("FILES");
    for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort())
      for (const sql of migrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))) await db.prepare(sql).run();
    await db.prepare("UPDATE cloud_trash_control SET cutover_ready=1 WHERE id=1").run();
    await db.prepare("INSERT INTO cloud_folders(id,name,created_by) VALUES(1,'live','admin'),(2,'expired tree','admin')").run();
    await db.prepare("INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(3,2,'child','admin')").run();
    for (let id = 1; id <= 6; id++) {
      await db.prepare(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by)
        VALUES(?,?,?,'synthetic','video/mp4','video',20,'ready','admin')`).bind(id, id === 6 ? 3 : 1, `originals/${id}`).run();
      await r2.put(`originals/${id}`, `fixture-video-data-${id}`);
    }
    await r2.put("thumbnails/1", "thumb");
    await db.prepare("UPDATE cloud_files SET thumbnail_key='thumbnails/1' WHERE id=1").run();
    // Objects without a cloud_files row must never be enumerated for deletion.
    await r2.put("unrelated/backup-sentinel", "preserve unrelated encrypted bytes");
    const request = path => mf.dispatchFetch(`http://fixture.test${path}`);
    const age = async (id, days) => {
      const { trash_operation_id: operation } = await db.prepare("SELECT trash_operation_id FROM cloud_files WHERE id=?").bind(id).first();
      const at = new Date(Date.now() - days * 86400000).toISOString();
      await db.batch([
        db.prepare("UPDATE cloud_trash_operations SET deleted_at=? WHERE id=?").bind(at, operation),
        db.prepare("UPDATE cloud_files SET deleted_at=? WHERE trash_operation_id=?").bind(at, operation),
        db.prepare("UPDATE cloud_folders SET deleted_at=? WHERE trash_operation_id=?").bind(at, operation)
      ]);
    };
    for (const id of [1, 3, 4]) assert.equal((await request(`/trash?id=${id}`)).status, 200);
    await age(1, 31); await age(3, 29); await age(4, 60);
    assert.equal((await request("/restore?id=4")).status, 200);
    await db.prepare("UPDATE cloud_files SET deleted_at=? WHERE id=5").bind(new Date(Date.now() - 90 * 86400000).toISOString()).run();
    assert.equal((await request("/trash-folder?id=2")).status, 200); await age(6, 31);
    const business = async () => JSON.stringify(await Promise.all(
      ["cloud_files", "cloud_folders", "cloud_trash_operations", "cloud_trash_purges", "cloud_trash_folder_purges"]
        .map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results)));
    const storage = async () => Promise.all((await r2.list()).objects.map(async object =>
      [object.key, await (await r2.get(object.key)).text()]));
    const beforeBusiness = await business(), beforeStorage = await storage();
    for (let run = 0; run < 2; run++) {
      const result = await (await request("/dry-run")).json();
      assert.equal(result.failed, 0); assert.equal(result.deleted, 0); assert.equal(result.skipped, 4);
      assert.equal(await business(), beforeBusiness); assert.deepEqual(await storage(), beforeStorage);
    }
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_audit_logs WHERE event_type='trash_run_finished'").first()).n, 2);
    const limited = await (await request("/limited-run")).json();
    assert.equal(limited.reason, "byte_limit"); assert.equal(limited.deleted, 0);
    assert.equal(await business(), beforeBusiness); assert.deepEqual(await storage(), beforeStorage);
    let result = await (await request("/run")).json();
    assert.equal(result.failed, 0); assert.equal(result.deleted, 2); assert.equal(result.deletedFolders, 1);
    result = await (await request("/run")).json();
    assert.equal(result.failed, 0); assert.equal(result.deletedFolders, 1);
    for (const id of [2, 3, 4, 5]) {
      assert.ok(await db.prepare("SELECT id FROM cloud_files WHERE id=?").bind(id).first());
      assert.equal(await (await r2.get(`originals/${id}`)).text(), `fixture-video-data-${id}`);
    }
    assert.deepEqual(await storage(), beforeStorage.filter(([key]) => !["originals/1", "originals/6", "thumbnails/1"].includes(key)));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_trash_purges WHERE phase='completed'").first()).n, 2);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_folders WHERE id=1 AND deleted_at IS NULL").first()).n, 1);
  } finally { await mf.dispose(); }
});

test("workerd: all migrations, atomic rollback, R2 deletion, persisted partial state and retry", async () => {
  const mf = new Miniflare((convertV4MiniflareOptions || (options => options))({ workers: [{ modules: true, script, compatibilityDate: "2026-08-01",
    d1Databases: ["DB"], r2Buckets: ["FILES"], bindings: { TRASH_RETENTION_MODE: "enabled", TRASH_CUTOVER_MODE: "ready" } }] }));
  try {
    const db = await mf.getD1Database("DB"), r2 = await mf.getR2Bucket("FILES");
    for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(n => n.endsWith(".sql")).sort())
      for (const sql of migrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")))
        await db.prepare(sql).run();
    await db.prepare("UPDATE cloud_trash_control SET cutover_ready=1 WHERE id=1").run();
    await db.prepare("INSERT INTO cloud_folders(id,name,created_by) VALUES(1,'photos','admin')").run();
    for (const id of [1, 2]) {
      await db.prepare(`INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by)
        VALUES(?,1,?,'fixture','image/jpeg','image',4,'ready','admin')`).bind(id, `originals/${id}`).run();
      await r2.put(`originals/${id}`, "test");
    }
    const request = path => mf.dispatchFetch(`http://fixture.test${path}`);
    assert.equal((await request("/trash?id=1")).status, 200);
    assert.equal((await request("/run")).status, 200);
    assert.ok(await r2.head("originals/1"), "new trash is too young");
    const at = new Date(Date.now() - 31 * 86400000).toISOString();
    await db.prepare("UPDATE cloud_trash_operations SET deleted_at=?").bind(at).run();
    await db.prepare("UPDATE cloud_files SET deleted_at=? WHERE id=1").bind(at).run();
    // Inject a D1 failure after the claim INSERT. The real D1 batch must undo
    // both trigger writes as well as the manifest, before any R2 delete.
    await db.prepare(`CREATE TRIGGER fail_claim_audit BEFORE INSERT ON cloud_audit_logs
      WHEN NEW.event_type='trash_purge_claimed' BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;`).run();
    let result = await (await request("/run")).json();
    assert.equal(result.failed, 1);
    assert.equal((await db.prepare("SELECT purge_id FROM cloud_files WHERE id=1").first()).purge_id, null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM cloud_trash_purges").first()).n, 0);
    assert.ok(await r2.head("originals/1"));
    await db.prepare("DROP TRIGGER fail_claim_audit").run();
    // Fail final D1 deletion after R2 succeeded, then retry a new invocation.
    await db.prepare(`CREATE TRIGGER fail_finalize BEFORE DELETE ON cloud_files
      BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;`).run();
    result = await (await request("/run")).json(); assert.equal(result.failed, 1);
    assert.equal(await r2.head("originals/1"), null);
    assert.ok(await r2.head("originals/2"), "live file is unchanged");
    assert.equal((await request("/restore?id=1")).status, 409);
    await db.prepare("DROP TRIGGER fail_finalize").run();
    result = await (await request("/run")).json(); assert.equal(result.deleted, 1);
    assert.equal((await db.prepare("SELECT phase FROM cloud_trash_purges WHERE file_id=1").first()).phase, "completed");
    // Absent-key deletion is a successful real local R2 operation.
    await r2.delete("originals/1");
    await assert.rejects(db.prepare("UPDATE cloud_files SET thumbnail_key='originals/1' WHERE id=2").run(), /trash_key_reserved/);
    // Legacy empty-child purges also make parent restoration fail atomically.
    await db.prepare("INSERT INTO cloud_folders(id,parent_id,name,created_by) VALUES(2,1,'empty','admin')").run();
    assert.equal((await request("/trash-folder?id=1")).status, 200);
    const emptied = await (await request("/empty")).json();
    assert.equal(emptied.deleted, 1); assert.equal(emptied.deletedFolders, 1);
    assert.equal(emptied.remaining, 1);
    assert.equal((await request("/restore-folder?id=1")).status, 409);
    assert.equal((await (await request("/empty")).json()).deletedFolders, 1);
  } finally { await mf.dispose(); }
});
