import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BACKUP_TABLES,
  backupKeys,
  createDiaryBackupPayload,
  pruneBackupGenerations,
  runDiaryBackup,
  runScheduledDiaryBackup,
  scheduleIndependentTasks
} from "../src/backup.js";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

const tableRows = {
  diary_entries: [{
    id: 1,
    entry_date: "2026-08-20",
    title: "バックアップ対象",
    content: "本文",
    created_at: "2026-08-20 00:00:00",
    updated_at: "2026-08-20 00:00:00",
    deleted_at: null,
    revision: 2,
    author_id: "main-user",
    author_name: "利用者",
    deleted_by_id: null,
    deleted_by_name: null,
    household_id: "tanaka-household",
    content_format: null,
    status: "draft",
    draft_of_entry_id: null,
    draft_of_revision: null,
    draft_excluded_photo_ids: "[]"
  }],
  diary_tags: [{ entry_id: 1, tag: "記録", created_at: "2026-08-20 00:00:00" }],
  diary_photos: [{
    id: "11111111-1111-4111-8111-111111111111",
    entry_id: 1,
    file_name: "photo.jpg",
    content_type: "image/jpeg",
    original_size: 1234,
    original_key: "entries/1/photos/1/original.jpg",
    display_key: "entries/1/photos/1/display.webp",
    thumbnail_key: "entries/1/photos/1/thumbnail.webp",
    width: 1200,
    height: 800,
    created_by_id: "main-user",
    created_by_name: "利用者",
    created_at: "2026-08-20 00:00:00"
  }],
  diary_trash_scopes: [{
    id: 1,
    entry_id: 1,
    owner_account_id: "main-user",
    household_id: "tanaka-household",
    scope_type: "personal",
    entry_revision: 2,
    deleted_by_id: "main-user",
    deleted_at: "2026-08-20 01:00:00",
    created_at: "2026-08-20 01:00:00"
  }],
  diary_favorites: [{ account_id: "main-user", entry_id: 1, created_at: "2026-08-20 00:00:00" }],
  diary_accounts: [{
    id: "main-user",
    household_id: "tanaka-household",
    display_name: "利用者",
    role: "user",
    can_manage_entries: 1,
    can_view_trash: 1,
    can_permanently_delete: 1,
    can_view_investment: 1,
    active: 1,
    created_at: "2026-08-01 00:00:00",
    updated_at: "2026-08-20 00:00:00"
  }]
};

function createDb({ fail = false } = {}) {
  return {
    prepare(sql) {
      const table = BACKUP_TABLES.find((candidate) => sql.includes(`FROM ${candidate.name}`));
      assert.ok(table, `Unexpected backup query: ${sql}`);
      return { table: table.name };
    },
    async batch(statements) {
      if (fail) throw new Error("temporary D1 failure");
      return statements.map((statement) => ({ success: true, results: structuredClone(tableRows[statement.table]) }));
    }
  };
}

class MemoryBucket {
  constructor() {
    this.objects = new Map();
    this.putCalls = [];
    this.failMonthlyOnce = false;
  }

  async put(key, value, options = {}) {
    if (this.failMonthlyOnce && key.startsWith("monthly/")) {
      this.failMonthlyOnce = false;
      throw new Error("temporary monthly write failure");
    }
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { key, bytes: new Uint8Array(bytes), options });
    this.putCalls.push(key);
    return { key, size: bytes.byteLength };
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? { key, size: object.bytes.byteLength } : null;
  }

  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const offset = cursor ? Number(cursor) : 0;
    const selected = keys.slice(offset, offset + limit);
    const next = offset + selected.length;
    return {
      objects: selected.map((key) => ({ key, size: this.objects.get(key).bytes.byteLength })),
      truncated: next < keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {})
    };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

function readBackup(bucket, key) {
  const object = bucket.objects.get(key);
  assert.ok(object, `Missing backup object: ${key}`);
  return JSON.parse(gunzipSync(object.bytes).toString("utf8"));
}

const nearUtcMidnight = Date.parse("2026-08-19T15:30:00.000Z");
assert.deepEqual(backupKeys(nearUtcMidnight), {
  date: "2026-08-20",
  month: "2026-08",
  daily: "daily/2026-08-20.json.gz",
  monthly: "monthly/2026-08.json.gz"
});

const payload = await createDiaryBackupPayload(createDb(), nearUtcMidnight);
assert.equal(payload.formatVersion, 1);
assert.equal(payload.japanDate, "2026-08-20");
assert.equal(payload.source.database, "diary-db");
assert.equal(payload.tables.diary_entries.rows[0].content, "本文");
assert.equal(payload.tables.diary_entries.rows[0].status, "draft");
assert.equal(payload.tables.diary_tags.rows[0].tag, "記録");
assert.equal(payload.tables.diary_photos.rows[0].original_key, "entries/1/photos/1/original.jpg");
assert.equal(payload.tables.diary_trash_scopes.rows[0].scope_type, "personal");
assert.equal(payload.tables.diary_favorites.rowCount, 1);
assert.equal(payload.tables.diary_accounts.rows[0].household_id, "tanaka-household");
const serialized = JSON.stringify(payload);
for (const excluded of ["diary_login_attempts", "diary_media_deletion_queue", "password_hash", "login_id", "session_version"]) {
  assert.equal(serialized.includes(excluded), false, `${excluded} must not be included in backups`);
}

const bucket = new MemoryBucket();
const media = { copied: 0, async put() { this.copied += 1; } };
const first = await runDiaryBackup({ DB: createDb(), BACKUP: bucket, MEDIA: media }, { nowMs: nearUtcMidnight });
assert.equal(first.complete, true);
assert.equal(first.monthlyCreated, true);
assert.equal(media.copied, 0, "photo objects must not be copied to the backup bucket");
assert.equal(bucket.objects.size, 2);
assert.equal(bucket.objects.get(first.dailyKey).options.httpMetadata.contentEncoding, "gzip");
assert.equal(readBackup(bucket, first.dailyKey).tables.diary_photos.rowCount, 1);

const second = await runDiaryBackup({ DB: createDb(), BACKUP: bucket, MEDIA: media }, { nowMs: nearUtcMidnight + 60_000 });
assert.equal(second.monthlyCreated, false);
assert.equal(bucket.objects.size, 2, "same-day rerun must replace the daily object instead of creating another generation");
assert.equal(bucket.putCalls.filter((key) => key.startsWith("daily/")).length, 2);
assert.equal(bucket.putCalls.filter((key) => key.startsWith("monthly/")).length, 1);

const retryBucket = new MemoryBucket();
retryBucket.failMonthlyOnce = true;
await assert.rejects(() => runDiaryBackup({ DB: createDb(), BACKUP: retryBucket }, { nowMs: nearUtcMidnight }), /monthly write failure/);
assert.equal([...retryBucket.objects.keys()].filter((key) => key.startsWith("monthly/")).length, 0);
const retry = await runDiaryBackup({ DB: createDb(), BACKUP: retryBucket }, { nowMs: nearUtcMidnight + 86_400_000 });
assert.equal(retry.monthlyCreated, true, "a later successful run in the same month must create the missing monthly backup");
assert.equal([...retryBucket.objects.keys()].filter((key) => key.startsWith("monthly/")).length, 1);

const retentionBucket = new MemoryBucket();
for (let day = 1; day <= 31; day += 1) {
  const key = `daily/2026-07-${String(day).padStart(2, "0")}.json.gz`;
  await retentionBucket.put(key, new Uint8Array([day]));
}
for (let month = 1; month <= 12; month += 1) {
  await retentionBucket.put(`monthly/2025-${String(month).padStart(2, "0")}.json.gz`, new Uint8Array([month]));
}
await retentionBucket.put("monthly/2026-01.json.gz", new Uint8Array([1]));
await retentionBucket.put("daily/not-a-date.json.gz", new Uint8Array([1]));
await retentionBucket.put("monthly/2026-99.json.gz", new Uint8Array([1]));
await retentionBucket.put("other/do-not-delete.json.gz", new Uint8Array([1]));
assert.equal((await pruneBackupGenerations(retentionBucket, "daily/", 30)).deleted, 1);
assert.equal((await pruneBackupGenerations(retentionBucket, "monthly/", 12)).deleted, 1);
assert.equal([...retentionBucket.objects.keys()].filter((key) => /^daily\/\d{4}-\d{2}-\d{2}\.json\.gz$/.test(key)).length, 30);
assert.equal([...retentionBucket.objects.keys()].filter((key) => /^monthly\/\d{4}-\d{2}\.json\.gz$/.test(key) && !key.endsWith("-99.json.gz")).length, 12);
for (const key of ["daily/not-a-date.json.gz", "monthly/2026-99.json.gz", "other/do-not-delete.json.gz"]) {
  assert.ok(retentionBucket.objects.has(key), `unexpected keys must remain untouched: ${key}`);
}

const scheduledFailure = await runScheduledDiaryBackup({ DB: createDb({ fail: true }), BACKUP: new MemoryBucket() }, nearUtcMidnight);
assert.equal(scheduledFailure.complete, false);

const scheduled = [];
let backupRan = false;
let cleanupRan = false;
scheduleIndependentTasks({ waitUntil(promise) { scheduled.push(promise); } }, [
  async () => { backupRan = true; throw new Error("backup failed"); },
  async () => { cleanupRan = true; return { complete: true }; }
]);
const settled = await Promise.allSettled(scheduled);
assert.equal(backupRan, true);
assert.equal(cleanupRan, true);
assert.equal(settled[0].status, "rejected");
assert.equal(settled[1].status, "fulfilled");

const reverseScheduled = [];
backupRan = false;
cleanupRan = false;
scheduleIndependentTasks({ waitUntil(promise) { reverseScheduled.push(promise); } }, [
  async () => { backupRan = true; return { complete: true }; },
  async () => { cleanupRan = true; throw new Error("cleanup failed"); }
]);
const reverseSettled = await Promise.allSettled(reverseScheduled);
assert.equal(backupRan, true);
assert.equal(cleanupRan, true);
assert.equal(reverseSettled[0].status, "fulfilled");
assert.equal(reverseSettled[1].status, "rejected");

const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
assert.deepEqual(wrangler.triggers.crons, ["25 18 * * *"], "the existing daily Cron must be reused");
assert.ok(wrangler.r2_buckets.some((binding) => binding.binding === "MEDIA" && binding.bucket_name === "t-room-diary-media"));
assert.ok(wrangler.r2_buckets.some((binding) => binding.binding === "BACKUP" && binding.bucket_name === "t-room-diary-backups"));
assert.match(workerSource, /runScheduledDiaryBackup/);
assert.match(workerSource, /runScheduledMediaDeletionCleanup/);
assert.doesNotMatch(workerSource, /\/api\/backup/i, "backup objects must not be exposed through a diary API");

process.stdout.write(`Diary backup tests passed (${first.compressedBytes} compressed bytes in fixture).\n`);
