import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  PHOTO_BACKUP_PREFIX,
  backupKeys,
  createDiaryBackupPayload,
  formalPhotoBackupKey,
  pruneBackupGenerations,
  restoreDiaryBackup,
  restoreFormalPhotoObjects,
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
    content_format: '{"version":1,"runs":[{"start":0,"end":2,"bold":true,"italic":false,"underline":false,"color":null}]}',
    status: "draft",
    draft_of_entry_id: null,
    draft_of_revision: null,
    draft_excluded_photo_ids: "[]",
    client_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_request_hash: "request-hash",
    last_mutation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  }],
  diary_tags: [
    { entry_id: 1, tag: "Z", created_at: "2026-08-20 00:00:00", sort_order: 0 },
    { entry_id: 1, tag: "A", created_at: "2026-08-20 00:00:01", sort_order: 1 },
    { entry_id: 1, tag: "ふゆ", created_at: "2026-08-20 00:00:02", sort_order: 2 }
  ],
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
  }],
  investment_history: [{
    recorded_at: "2026-08-20",
    total: 12345678,
    cash: 1000000,
    stocks: 4000000,
    funds: 3000000,
    bonds: 500000,
    crypto: 2000000,
    futures: 250000,
    points: 12345,
    other: 572333,
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
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { key, bytes: new Uint8Array(bytes), options });
    this.putCalls.push(key);
    return { key, size: bytes.byteLength };
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? {
      key,
      size: object.bytes.byteLength,
      customMetadata: object.options.customMetadata || null,
      httpMetadata: object.options.httpMetadata || null
    } : null;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.bytes.byteLength,
      body: new Blob([object.bytes]).stream(),
      httpMetadata: object.options.httpMetadata || null,
      customMetadata: object.options.customMetadata || null,
      writeHttpMetadata(headers) {
        if (object.options.httpMetadata?.contentType) headers.set("Content-Type", object.options.httpMetadata.contentType);
      }
    };
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

async function createMediaFixture() {
  const media = new MemoryBucket();
  const photo = tableRows.diary_photos[0];
  await media.put(photo.original_key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
  await media.put(photo.display_key, new Uint8Array([4, 5]), { httpMetadata: { contentType: "image/webp" } });
  await media.put(photo.thumbnail_key, new Uint8Array([6]), { httpMetadata: { contentType: "image/webp" } });
  await media.put("diary/staging/not-formal/original", new Uint8Array([99]));
  return media;
}

class SqliteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((descriptor) => {
        const statement = this.database.prepare(descriptor.sql);
        if (/^\s*SELECT\b/i.test(descriptor.sql)) {
          return { success: true, results: statement.all(...descriptor.bindings) };
        }
        const meta = statement.run(...descriptor.bindings);
        return {
          success: true,
          results: [],
          meta: { changes: Number(meta.changes), last_row_id: Number(meta.lastInsertRowid || 0) }
        };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function migratedEmptyDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  const migrations = [
    "0001_init.sql", "0002_entry_authors.sql", "0003_investment_history.sql", "0004_entry_deletion_actor.sql",
    "0005_diary_photos.sql", "0006_login_attempts.sql", "0007_household_isolation.sql", "0008_chiharu_login_reset.sql",
    "0009_main_user.sql", "0010_entry_rich_text.sql", "0011_trash_scopes.sql", "0012_entry_drafts.sql",
    "0013_main_user_trash_and_media_retry.sql", "0014_diary_favorites.sql", "0015_photo_upload_staging.sql",
    "0016_entry_write_integrity.sql", "0017_diary_tag_order.sql"
  ];
  for (const migration of migrations) database.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));
  database.exec(`
    DELETE FROM diary_entries;
    DELETE FROM diary_accounts;
    DELETE FROM investment_history;
    DELETE FROM diary_login_attempts;
    DELETE FROM diary_media_deletion_queue;
    DELETE FROM diary_photo_upload_sessions;
  `);
  return database;
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
assert.equal(payload.formatVersion, BACKUP_FORMAT_VERSION);
assert.equal(payload.japanDate, "2026-08-20");
assert.equal(payload.source.database, "diary-db");
assert.equal(payload.tables.diary_entries.rows[0].content, "本文");
assert.equal(payload.tables.diary_entries.rows[0].status, "draft");
assert.deepEqual(payload.tables.diary_tags.rows.map((row) => [row.tag, row.sort_order]), [
  ["Z", 0], ["A", 1], ["ふゆ", 2]
]);
assert.equal(payload.tables.diary_photos.rows[0].original_key, "entries/1/photos/1/original.jpg");
assert.equal(payload.tables.diary_trash_scopes.rows[0].scope_type, "personal");
assert.equal(payload.tables.diary_favorites.rowCount, 1);
assert.equal(payload.tables.diary_accounts.rows[0].household_id, "tanaka-household");
assert.equal(payload.tables.investment_history.rowCount, 1);
assert.deepEqual(payload.tables.investment_history.rows[0], tableRows.investment_history[0]);
const serialized = JSON.stringify(payload);
for (const excluded of ["diary_login_attempts", "diary_media_deletion_queue", "password_hash", "login_id", "session_version"]) {
  assert.equal(serialized.includes(excluded), false, `${excluded} must not be included in backups`);
}

const bucket = new MemoryBucket();
const media = await createMediaFixture();
const first = await runDiaryBackup({ DB: createDb(), BACKUP: bucket, MEDIA: media }, { nowMs: nearUtcMidnight });
assert.equal(first.complete, true);
assert.equal(first.monthlyCreated, true);
assert.equal(first.mediaBackup.copied, 3, "only the three formal photo variants must be copied once");
assert.equal(bucket.objects.size, 5);
assert.equal(bucket.objects.get(first.dailyKey).options.httpMetadata.contentEncoding, "gzip");
assert.equal(readBackup(bucket, first.dailyKey).tables.diary_photos.rowCount, 1);
assert.equal(readBackup(bucket, first.dailyKey).mediaBackup.complete, true);
assert.equal(bucket.objects.has(`${PHOTO_BACKUP_PREFIX}not-formal/original`), false, "staging objects outside the formal D1 ledger must not be copied");
for (const [variant] of [["original"], ["display"], ["thumbnail"]]) {
  assert.ok(bucket.objects.has(formalPhotoBackupKey(tableRows.diary_photos[0].id, variant)));
}

const second = await runDiaryBackup({ DB: createDb(), BACKUP: bucket, MEDIA: media }, { nowMs: nearUtcMidnight + 60_000 });
assert.equal(second.monthlyCreated, false);
assert.equal(second.mediaBackup.copied, 0, "differential backup must not recopy existing formal media");
assert.equal(second.mediaBackup.existing, 3);
assert.equal(bucket.objects.size, 5, "same-day rerun must replace D1 data without duplicating media objects");
assert.equal(bucket.putCalls.filter((key) => key.startsWith("daily/")).length, 2);
assert.equal(bucket.putCalls.filter((key) => key.startsWith("monthly/")).length, 1);

const legacyMonthlyBucket = new MemoryBucket();
await legacyMonthlyBucket.put("monthly/2026-08.json.gz", new Uint8Array([1]), {
  customMetadata: { format: "troom-diary-d1-v1" }
});
const upgradedMonthly = await runDiaryBackup({
  DB: createDb(),
  BACKUP: legacyMonthlyBucket,
  MEDIA: await createMediaFixture()
}, { nowMs: nearUtcMidnight });
assert.equal(upgradedMonthly.monthlyCreated, false);
assert.equal(upgradedMonthly.monthlyUpgraded, true, "an existing monthly generation must be upgraded once when the backup format changes");
assert.equal(legacyMonthlyBucket.objects.get("monthly/2026-08.json.gz").options.customMetadata.format, `troom-diary-d1-v${BACKUP_FORMAT_VERSION}`);

const restoredDatabase = await migratedEmptyDatabase();
const restoreResult = await restoreDiaryBackup(new SqliteD1(restoredDatabase), readBackup(bucket, first.dailyKey));
assert.equal(restoreResult.complete, true);
for (const table of BACKUP_TABLES) {
  const restoredRows = restoredDatabase.prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.orderBy}`).all()
    .map((row) => ({ ...row }));
  assert.deepEqual(restoredRows, tableRows[table.name], `restored rows must match for ${table.name}`);
}
const restoredAccountSecrets = restoredDatabase.prepare(`
  SELECT login_id, password_hash, must_change_password, session_version
  FROM diary_accounts WHERE id = ?
`).get("main-user");
assert.match(restoredAccountSecrets.login_id, /@invalid\.local$/);
assert.equal(restoredAccountSecrets.password_hash, null);
assert.equal(Number(restoredAccountSecrets.must_change_password), 1);
assert.equal(Number(restoredAccountSecrets.session_version), 1);
await assert.rejects(
  () => restoreDiaryBackup(new SqliteD1(restoredDatabase), readBackup(bucket, first.dailyKey)),
  /Restore target must be empty/,
  "restore must fail closed instead of merging into a non-empty target"
);

const version2Payload = structuredClone(readBackup(bucket, first.dailyKey));
version2Payload.formatVersion = 2;
version2Payload.tables.diary_tags.columns = ["entry_id", "tag", "created_at"];
version2Payload.tables.diary_tags.rows = version2Payload.tables.diary_tags.rows.map(({ sort_order: _sortOrder, ...row }) => row);
const version2RestoredDatabase = await migratedEmptyDatabase();
const version2Restore = await restoreDiaryBackup(new SqliteD1(version2RestoredDatabase), version2Payload);
assert.equal(version2Restore.complete, true);
assert.deepEqual(
  version2RestoredDatabase.prepare("SELECT tag, sort_order FROM diary_tags WHERE entry_id = 1 ORDER BY sort_order ASC").all()
    .map((row) => ({ ...row })),
  [
    { tag: "Z", sort_order: 0 },
    { tag: "A", sort_order: 1 },
    { tag: "ふゆ", sort_order: 2 }
  ],
  "v2 backups must restore every tag and assign stable order values from their stored row order"
);

const restoredMedia = new MemoryBucket();
const photoRestore = await restoreFormalPhotoObjects({ BACKUP: bucket, MEDIA: restoredMedia }, readBackup(bucket, first.dailyKey));
assert.deepEqual(photoRestore, { complete: true, restored: 3, existing: 0, missing: 0, failed: 0 });
for (const [variant, sourceColumn] of [["original", "original_key"], ["display", "display_key"], ["thumbnail", "thumbnail_key"]]) {
  const restoredObject = restoredMedia.objects.get(tableRows.diary_photos[0][sourceColumn]);
  const backupObject = bucket.objects.get(formalPhotoBackupKey(tableRows.diary_photos[0].id, variant));
  assert.deepEqual(restoredObject.bytes, backupObject.bytes, `restored ${variant} must match the backup object`);
}
const idempotentPhotoRestore = await restoreFormalPhotoObjects({ BACKUP: bucket, MEDIA: restoredMedia }, readBackup(bucket, first.dailyKey));
assert.equal(idempotentPhotoRestore.restored, 0);
assert.equal(idempotentPhotoRestore.existing, 3);

const retryBucket = new MemoryBucket();
retryBucket.failMonthlyOnce = true;
const retryMedia = await createMediaFixture();
await assert.rejects(() => runDiaryBackup({ DB: createDb(), BACKUP: retryBucket, MEDIA: retryMedia }, { nowMs: nearUtcMidnight }), /monthly write failure/);
assert.equal([...retryBucket.objects.keys()].filter((key) => key.startsWith("monthly/")).length, 0);
const retry = await runDiaryBackup({ DB: createDb(), BACKUP: retryBucket, MEDIA: retryMedia }, { nowMs: nearUtcMidnight + 86_400_000 });
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
await retentionBucket.put(formalPhotoBackupKey("retained-photo", "original"), new Uint8Array([1]));
assert.equal((await pruneBackupGenerations(retentionBucket, "daily/", 30)).deleted, 1);
assert.equal((await pruneBackupGenerations(retentionBucket, "monthly/", 12)).deleted, 1);
assert.equal([...retentionBucket.objects.keys()].filter((key) => /^daily\/\d{4}-\d{2}-\d{2}\.json\.gz$/.test(key)).length, 30);
assert.equal([...retentionBucket.objects.keys()].filter((key) => /^monthly\/\d{4}-\d{2}\.json\.gz$/.test(key) && !key.endsWith("-99.json.gz")).length, 12);
for (const key of [
  "daily/not-a-date.json.gz",
  "monthly/2026-99.json.gz",
  "other/do-not-delete.json.gz",
  formalPhotoBackupKey("retained-photo", "original")
]) {
  assert.ok(retentionBucket.objects.has(key), `unexpected keys must remain untouched: ${key}`);
}

const originalConsoleError = console.error;
const backupFailureLogs = [];
console.error = (...values) => backupFailureLogs.push(values.join(" "));
let scheduledFailure;
try {
  scheduledFailure = await runScheduledDiaryBackup({
    DB: createDb({ fail: true }),
    BACKUP: new MemoryBucket(),
    MEDIA: await createMediaFixture()
  }, nearUtcMidnight);
} finally {
  console.error = originalConsoleError;
}
assert.equal(scheduledFailure.complete, false);
assert.match(backupFailureLogs.join("\n"), /"event":"diary_backup_failed"/);
assert.match(backupFailureLogs.join("\n"), /"errorType":"Error"/);
assert.doesNotMatch(backupFailureLogs.join("\n"), /temporary D1 failure/,
  "scheduled errors must not log database messages that could contain diary or secret data");

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
