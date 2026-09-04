import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const foundation = await readFile(new URL("../migrations/0001_downloader_foundation.sql", import.meta.url), "utf8");
const usageMigration = await readFile(new URL("../migrations/0002_downloader_usage_stats.sql", import.meta.url), "utf8");

function metric(db, metricName, dimension) {
  return db.prepare(`SELECT event_count, byte_count, value_sum, value_max
    FROM downloader_usage_daily WHERE metric = ? AND dimension = ?`)
    .get(metricName, dimension) || { event_count: 0, byte_count: 0, value_sum: 0, value_max: 0 };
}

function insertJob(db, id, status = "analyzing", createdAt = "2026-09-03 16:00:00") {
  db.prepare(`INSERT INTO downloader_jobs
    (id, identity_id, service_link_id, client_request_id, status, source_hostname, url_hash, created_at, updated_at)
    VALUES (?, 'primary-admin', 'link-owner', ?, ?, 'media.example', ?, ?, ?)`)
    .run(id, `request-${id}`, status, `hash-${id}`, createdAt, createdAt);
}

test("usage migrationは既存履歴をbackfillし新規状態遷移を一度だけ集計する", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(foundation);
  insertJob(db, "historical-ready", "ready");
  db.prepare(`UPDATE downloader_jobs SET normalization_mode = 'REMUX', actual_size = 900,
    downloaded_at = '2026-09-03 16:05:00', queued_at = '2026-09-03 16:01:00' WHERE id = 'historical-ready'`).run();
  insertJob(db, "historical-failed", "failed");

  db.exec(usageMigration);
  assert.equal(metric(db, "request", "analyze").event_count, 2);
  assert.equal(metric(db, "request", "download").event_count, 1);
  assert.equal(metric(db, "result", "success").event_count, 1);
  assert.equal(metric(db, "normalization", "REMUX").event_count, 1);
  assert.equal(metric(db, "bytes", "r2_stored").byte_count, 900);
  assert.equal(metric(db, "outcome", "failed").event_count, 1);

  insertJob(db, "fresh");
  assert.equal(metric(db, "request", "analyze").event_count, 3);
  db.prepare("UPDATE downloader_jobs SET status = 'analyzed', analyzed_at = '2026-09-03 16:10:00' WHERE id = 'fresh'").run();
  db.prepare("UPDATE downloader_jobs SET status = 'queued', queued_at = '2026-09-03 16:11:00' WHERE id = 'fresh'").run();
  db.prepare("UPDATE downloader_jobs SET status = 'queued' WHERE id = 'fresh'").run();
  assert.equal(metric(db, "request", "download").event_count, 2);

  db.prepare("UPDATE downloader_jobs SET status = 'processing' WHERE id = 'fresh'").run();
  db.prepare(`UPDATE downloader_jobs SET status = 'ready', normalization_mode = 'PASS_THROUGH',
    source_bytes = 1100, actual_size = 1000, container_cpu_ms = 2500, container_wall_ms = 5000,
    container_peak_rss_bytes = 6000, container_work_bytes = 7000,
    downloaded_at = '2026-09-03 16:12:00' WHERE id = 'fresh'`).run();
  db.prepare("UPDATE downloader_jobs SET status = 'ready', updated_at = '2026-09-03 16:13:00' WHERE id = 'fresh'").run();
  assert.equal(metric(db, "result", "success").event_count, 2);
  assert.equal(metric(db, "normalization", "PASS_THROUGH").event_count, 1);
  assert.equal(metric(db, "bytes", "source").byte_count, 1100);
  assert.equal(metric(db, "bytes", "r2_stored").byte_count, 1900);
  assert.equal(metric(db, "resource", "container_cpu_ms").value_sum, 2500);
  assert.equal(metric(db, "resource", "container_peak_rss").value_max, 6000);

  db.prepare(`INSERT OR IGNORE INTO downloader_file_delivery_attempts
    (job_id, attempt_id, identity_id, day_jst, byte_count) VALUES ('fresh', 'click-one', 'primary-admin', '2026-09-04', 1000)`).run();
  db.prepare(`INSERT OR IGNORE INTO downloader_file_delivery_attempts
    (job_id, attempt_id, identity_id, day_jst, byte_count) VALUES ('fresh', 'click-one', 'primary-admin', '2026-09-04', 1000)`).run();
  assert.equal(metric(db, "delivery", "started").event_count, 1, "Range/retry of one click must not inflate delivery count");
  assert.equal(metric(db, "delivery", "started").byte_count, 1000);
  db.prepare(`INSERT OR IGNORE INTO downloader_file_delivery_attempts
    (job_id, attempt_id, identity_id, day_jst, byte_count) VALUES ('fresh', 'click-two', 'primary-admin', '2026-09-04', 1000)`).run();
  assert.equal(metric(db, "delivery", "started").event_count, 2, "a separate user click counts as another delivery");

  db.prepare("UPDATE downloader_jobs SET status = 'expired', deleted_at = '2026-09-03 16:22:00' WHERE id = 'fresh'").run();
  const storedDuration = metric(db, "resource", "r2_storage_byte_seconds").value_sum;
  assert.equal(storedDuration, 600_000);
  db.prepare("UPDATE downloader_jobs SET status = 'deleted', deleted_at = '2026-09-03 16:23:00' WHERE id = 'fresh'").run();
  assert.equal(metric(db, "resource", "r2_storage_byte_seconds").value_sum, storedDuration, "retiring an already-expired job must not double-count storage duration");

  insertJob(db, "new-failure");
  db.prepare("UPDATE downloader_jobs SET status = 'failed', failure_category = 'scanner_timeout' WHERE id = 'new-failure'").run();
  db.prepare("UPDATE downloader_jobs SET status = 'failed' WHERE id = 'new-failure'").run();
  assert.equal(metric(db, "security", "scanner_timeout").event_count, 1);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close();
});

test("usage tables do not retain source URL, query, filename, cookie, or authorization", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(foundation);
  db.exec(usageMigration);
  for (const table of ["downloader_usage_daily", "downloader_file_delivery_attempts"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
    assert.equal(columns.some((name) => /url|query|filename|cookie|authorization/i.test(name)), false);
  }
  db.close();
});
