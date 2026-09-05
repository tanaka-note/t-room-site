import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { aggregateUsageRows, estimateDownloaderCost } from "../src/downloader-usage.js";
import * as domain from "../src/downloader-domain.js";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migrations = await Promise.all(["0001_downloader_foundation.sql", "0002_downloader_usage_stats.sql", "0003_downloader_progress_metrics.sql", "0004_downloader_final_metrics.sql"].map(file => readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")));
const context = {};
vm.runInNewContext(source.slice(source.indexOf("async function finalizeContainerMetrics("), source.indexOf("async function markDownloadFailed(")) + ";this.finalize = finalizeContainerMetrics; this.normalize = normalizeContainerMetrics;", context);
function setup(upgraded = true) {
  const db = new DatabaseSync(":memory:");
  for (const sql of migrations.slice(0, upgraded ? 4 : 3)) db.exec(sql);
  return db;
}
function envFor(db) {
  return { DB: { prepare: sql => ({ bind(...values) { this.values = values; return this; }, async first() { return db.prepare(sql).get(...this.values); }, async run() { return { meta: db.prepare(sql).run(...this.values) }; } }) } };
}
function insert(db, id = "job", owner = "owner") {
  db.prepare(`INSERT INTO downloader_jobs (id,identity_id,service_link_id,client_request_id,status,source_hostname,url_hash)
    VALUES (?,?,'link',?,'processing','example.com','hash')`).run(id, owner, id);
}
function commit(db, id = "job", cpu = 100, wall = 1500) {
  db.prepare(`UPDATE downloader_jobs SET status='ready',downloaded_at='2026-09-05 14:59:59',
    actual_size=1000, container_cpu_ms=?,container_wall_ms=?,metrics_token='winner',
    container_peak_rss_bytes=100,container_work_bytes=200 WHERE id=?`).run(cpu, wall, id);
}
function row(db, dimension, owner = "owner", day = "2026-09-05") {
  return db.prepare("SELECT * FROM downloader_usage_daily WHERE identity_id=? AND day_jst=? AND dimension=?").get(owner, day, dimension);
}
const attempt = { jobId: "job", identityId: "owner", processingToken: "winner" };
const final = { cpuUserMs: 160, cpuSystemMs: 40, wallMs: 2500, containerPeakRssBytes: 150, observedWorkBytes: 250, cpuScope: "cgroup_v2", phaseMs: { upload: 1000 } };

test("reproduce old final-value drift; additive migration retains historical rows exactly", () => {
  const db = setup(false);
  try {
    insert(db);
    db.exec("UPDATE downloader_jobs SET status='ready',downloaded_at='2026-09-05 14:59:59',container_cpu_ms=100,container_wall_ms=1500");
    db.exec("UPDATE downloader_jobs SET container_cpu_ms=200,container_wall_ms=2500");
    assert.equal(row(db, "container_cpu_ms").value_sum, 100);
    assert.equal(row(db, "container_wall_ms").value_sum, 1500);
    const before = db.prepare("SELECT * FROM downloader_usage_daily ORDER BY day_jst,identity_id,metric,dimension").all();
    db.exec(migrations[3]);
    assert.deepEqual(db.prepare("SELECT * FROM downloader_usage_daily ORDER BY day_jst,identity_id,metric,dimension").all(), before);
    const job = db.prepare("SELECT * FROM downloader_jobs").get();
    assert.equal(job.container_cpu_ms, 200);
    assert.equal(job.metrics_token, null);
    assert.equal(job.usage_day_jst, null);
    const usage = aggregateUsageRows(before);
    assert.equal(usage.container.legacyMemoryGibSeconds, 726);
    assert.equal(usage.container.memoryGibSeconds, 0);
    assert.equal(estimateDownloaderCost(usage).components.find(c => c.name === "Containers memory").available, false);
  } finally { db.close(); }
});

test("final response applies once to the original user/day across midnight, including after deletion", async () => {
  for (const status of ["ready", "expired", "deleted"]) {
    const db = setup();
    try {
      insert(db); commit(db);
      insert(db, "other", "other-owner"); commit(db, "other");
      assert.equal(row(db, "container_observed_memory_gib_seconds").value_sum, 9);
      db.prepare("UPDATE downloader_jobs SET status=?,updated_at='2026-09-06 00:00:01' WHERE id='job'").run(status);
      const env = envFor(db);
      await context.finalize(env, { ...attempt, processingToken: "loser" }, final, 10);
      await context.finalize(env, { ...attempt, identityId: "other-owner" }, final, 10);
      assert.equal(row(db, "container_cpu_ms").value_sum, 100);
      // Concurrent callbacks contend on one SQL CAS. A subsequent older or larger
      // response cannot change the committed final measurement either.
      const results = await Promise.all([context.finalize(env, attempt, final, 10), context.finalize(env, attempt, final, 10)]);
      assert.equal(results.reduce((sum, r) => sum + r.meta.changes, 0), 1);
      await context.finalize(env, attempt, { ...final, wallMs: 99999, cpuUserMs: 99999 }, 999);
      await context.finalize(env, attempt, { ...final, wallMs: 1, cpuUserMs: 1 }, 1);
      assert.equal(row(db, "container_cpu_ms").value_sum, 200);
      assert.equal(row(db, "container_wall_ms").value_sum, 2500);
      assert.equal(row(db, "container_cpu_ms", "other-owner").value_sum, 100);
      assert.equal(row(db, "container_cpu_ms", "owner", "2026-09-06"), undefined);
      assert.equal(row(db, "container_observed_memory_gib_seconds").value_sum, 15);
      assert.equal(row(db, "container_observed_disk_gb_seconds").value_sum, 30);
      assert.equal(row(db, "container_peak_rss").value_max, 150);
      assert.equal(row(db, "container_peak_work").value_max, 250);
      assert.equal(row(db, "container_provisional").event_count, 0);
      assert.equal(row(db, "container_finalized").event_count, 1);
      assert.equal(row(db, "success").event_count, 1);
      assert.equal(db.prepare("SELECT upload_ms FROM downloader_jobs WHERE id='job'").get().upload_ms, 1000);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  }
});

test("missing metrics remain unknown; a lost final response retains provisional counts", async () => {
  const db = setup();
  try {
    insert(db); commit(db, "job", null, null);
    const env = envFor(db);
    await context.finalize(env, attempt, context.normalize({ wallMs: null, cpuUserMs: null, cpuSystemMs: null }), 10);
    assert.equal(db.prepare("SELECT metrics_finalized_at FROM downloader_jobs").get().metrics_finalized_at, null);
    let cost = estimateDownloaderCost(aggregateUsageRows(db.prepare("SELECT * FROM downloader_usage_daily").all()));
    assert.equal(cost.components.find(c => c.name === "Containers CPU").usage, null);
    assert.equal(cost.components.find(c => c.name === "Containers memory").usage, null);
    assert.equal(row(db, "container_provisional").event_count, 1);
    await context.finalize(env, attempt, final, 10);
    assert.equal(row(db, "container_cpu_ms").value_sum, 200);
    assert.equal(row(db, "container_cpu_ms").event_count, 1);
    assert.equal(row(db, "container_observed_memory_gib_seconds").event_count, 1);
  } finally { db.close(); }
});

test("a failed transaction rolls back job finalization and aggregate delta together", async () => {
  const db = setup();
  try {
    insert(db); commit(db);
    db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON downloader_usage_daily WHEN NEW.dimension='container_finalized' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    await assert.rejects(context.finalize(envFor(db), attempt, final, 10), /injected/);
    assert.equal(db.prepare("SELECT metrics_finalized_at FROM downloader_jobs").get().metrics_finalized_at, null);
    assert.equal(row(db, "container_cpu_ms").value_sum, 100);
    db.exec("DROP TRIGGER test_failure;");
    await context.finalize(envFor(db), attempt, final, 10);
    assert.equal(row(db, "container_cpu_ms").value_sum, 200);
  } finally { db.close(); }
});

test("actual upload CAS preserves the winning artifact and binds final metrics to its original processing token", async () => {
  const db = setup();
  try {
    insert(db);
    db.exec("UPDATE downloader_jobs SET processing_token='winner',processing_lease_expires_at=2000");
    let writes = 0, releasePut, putStarted;
    const gate = new Promise(resolve => { releasePut = resolve; });
    const started = new Promise(resolve => { putStarted = resolve; });
    const env = envFor(db);
    env.DOWNLOADS = { async put() { writes++; putStarted(); await gate; } };
    const uploadContext = {
      ...domain, Response, Request, console: { log() {} },
      verifyInternalGrant: async () => ({ jobId: "job", processingToken: "winner", objectKey: "downloads/job/winner", maxBytes: 10000, expiresAt: 1000 }),
      decodeHeaderValue: value => value, normalizeNormalizationMode: () => "PASS_THROUGH", nowSeconds: () => 100,
      contentDisposition: () => "attachment", safeRecordUsageItems: async () => {}, sendJobMessage: async () => {}, json: body => Response.json(body)
    };
    vm.runInNewContext(source.slice(source.indexOf("async function handleContainerUpload("), source.indexOf("async function listJobs(")) + source.slice(source.indexOf("function safeMetricHeader("), source.indexOf("\n", source.indexOf("function safeMetricHeader("))) + ";this.upload = handleContainerUpload;", uploadContext);
    const request = () => new Request("http://internal/upload", { method: "PUT", body: "safe", headers: {
      "Content-Length": "4", "Content-Type": "video/mp4", "X-Filename": "safe.mp4", "X-Content-SHA256": "a".repeat(64),
      "X-Container-Wall-Ms": "1500", "X-Container-CPU-User-Ms": "80", "X-Container-CPU-System-Ms": "20"
    } });
    const pending = uploadContext.upload(request(), env);
    await started;
    assert.equal((await uploadContext.upload(request(), env)).status, 409);
    releasePut();
    assert.equal((await pending).status, 200);
    assert.equal((await uploadContext.upload(request(), env)).status, 200);
    assert.equal(writes, 1);
    const job = db.prepare("SELECT * FROM downloader_jobs").get();
    assert.equal(job.metrics_token, "winner");
    assert.equal(job.processing_token, null);
    assert.equal(job.object_key, "downloads/job/winner");
    await context.finalize(env, { ...attempt, processingToken: "upload:winner" }, final, 10);
    assert.equal(db.prepare("SELECT metrics_finalized_at FROM downloader_jobs").get().metrics_finalized_at, null);
    await context.finalize(env, attempt, final, 10);
    assert.equal(row(db, "container_cpu_ms", "owner", job.usage_day_jst).value_sum, 200);
    assert.equal(row(db, "success", "owner", job.usage_day_jst).event_count, 1);
  } finally { db.close(); }
});

test("a lower final sample cannot decrease already recorded cumulative values", async () => {
  const db = setup();
  try {
    insert(db); commit(db);
    await context.finalize(envFor(db), attempt, { ...final, wallMs: 1, cpuUserMs: 1, cpuSystemMs: 1 }, 10);
    assert.equal(row(db, "container_wall_ms").value_sum, 1500);
    assert.equal(row(db, "container_cpu_ms").value_sum, 100);
  } finally { db.close(); }
});

test("ffprobe signal/resource/unknown exits are indistinguishable failures; parsed content rejection is separate", () => {
  const result = spawnSync(process.execPath, ["test/run-python.mjs", "-c", `
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from scanner import probe_file, _validate_media, UnsafeFile
for code, stderr in [(-9, ''), (-11, ''), (1, 'Cannot allocate memory'), (1, 'unknown'), (1, 'Invalid data found when processing input')]:
    with patch('scanner.subprocess.run', return_value=SimpleNamespace(returncode=code, stdout='', stderr=stderr)):
        try: probe_file(Path('/work/test.mp4'))
        except UnsafeFile as error: assert str(error) == 'ffprobe_failed'
        else: raise AssertionError('execution failure accepted')
with patch('scanner.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='invalid json', stderr='')):
    try: probe_file(Path('/work/test.mp4'))
    except UnsafeFile as error: assert str(error) == 'ffprobe_invalid'
    else: raise AssertionError('invalid parser response accepted')
try: _validate_media('video/mp4', {'streams': []})
except UnsafeFile as error: assert str(error) == 'invalid_media_stream'
else: raise AssertionError('invalid content accepted')
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
