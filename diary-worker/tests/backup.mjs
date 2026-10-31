import { Bucket, d1, database } from '../../backup-worker/test/fixtures.mjs';
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
  restoreDiaryBackup,
  restoreFormalPhotoObjects,
  runDiaryBackup,
  runScheduledDiaryBackup,
  scheduleIndependentTasks
} from "../src/backup.js";

import { backupPhotos, resolvePhotoManifest } from '../src/photo-backup.js';

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

const tableRows = {
  diary_entries: [{
    id: 1,
    entry_date: "2026-08-20",
    last_published_at: null,
    entry_time: "14:25",
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
    last_mutation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    weather: "sunny"
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
    original_size: 3,
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

function createDb({fail=false}={}) {
  if(fail) return {prepare(){throw new Error('temporary D1 failure');}};
  const db=database('diary');
  db.exec('PRAGMA foreign_keys=OFF');
  for(const t of [...BACKUP_TABLES].reverse()) db.exec('DELETE FROM '+t.name);
  for(const t of BACKUP_TABLES) for(const row of tableRows[t.name]) db.prepare('INSERT INTO '+t.name+' ('+[...t.columns,...(t.name==='diary_accounts'?['login_id']:[])].join(',')+') VALUES ('+[...t.columns,...(t.name==='diary_accounts'?['login_id']:[])].map(()=>'?').join(',')+')').run(...t.columns.map(c=>row[c]),...(t.name==='diary_accounts'?['synthetic@invalid.local']:[]));
  const api=d1(db); return api;
}
class MemoryBucket extends Bucket {
  putCalls=this.writes;
  failMonthlyOnce=false;
  async put(key,value,options={}) {
    if(this.failMonthlyOnce && key.startsWith('v8/monthly/')) {this.failMonthlyOnce=false;throw new Error('temporary monthly write failure');}
    const result=await super.put(key,value,options);
    if(result) result.options=options;
    return result;
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
        if (/^\s*(SELECT|WITH)\b/i.test(descriptor.sql)) {
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
    "0016_entry_write_integrity.sql", "0017_diary_tag_order.sql", "0018_diary_weather.sql",
    "0019_password_auth_policy.sql", "0020_diary_entry_time.sql", "0021_diary_last_published_at.sql"
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
  daily: "v8/daily/2026-08-20.json.gz",
  monthly: "v8/monthly/2026-08.json.gz"
});

const payload = await createDiaryBackupPayload(createDb(), nearUtcMidnight);
assert.equal(payload.formatVersion, BACKUP_FORMAT_VERSION);
assert.equal(payload.japanDate, "2026-08-20");
assert.equal(payload.source.database, "diary-db");
assert.equal(payload.tables.diary_entries.rows[0].content, "本文");
assert.equal(payload.tables.diary_entries.rows[0].last_published_at, null);
assert.equal(payload.tables.diary_entries.rows[0].entry_time, "14:25");
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
assert.equal(bucket.objects.size, 2);
assert.equal(readBackup(bucket, first.dailyKey).tables.diary_photos.rowCount, 1);
assert.equal(readBackup(bucket, first.dailyKey).backupScope, 'd1-only');
assert.equal(readBackup(bucket, first.dailyKey).mediaBackup, undefined);
assert.equal(bucket.writes.some(k=>k.startsWith('media/')), false);

const second = await runDiaryBackup({ DB: createDb(), BACKUP: bucket, MEDIA: media }, { nowMs: nearUtcMidnight + 60_000 });
assert.equal(second.monthlyCreated, false);
assert.equal(bucket.objects.size, 2, "same-day rerun must preserve the successful generation without duplicating media objects");
assert.equal(bucket.putCalls.filter((key) => key.startsWith("v8/daily/")).length, 1);
assert.equal(bucket.putCalls.filter((key) => key.startsWith("v8/monthly/")).length, 1);

const legacyMonthlyBucket = new MemoryBucket();
await legacyMonthlyBucket.put("monthly/2026-08.json.gz", new Uint8Array([1]), {
  customMetadata: { format: "troom-diary-d1-v1" }
});
const upgradedMonthly = await runDiaryBackup({
  DB: createDb(),
  BACKUP: legacyMonthlyBucket,
  MEDIA: await createMediaFixture()
}, { nowMs: nearUtcMidnight });
assert.equal(upgradedMonthly.monthlyCreated, true);
assert.equal(upgradedMonthly.monthlyUpgraded, false, "legacy generations must remain untouched");
assert.equal(legacyMonthlyBucket.objects.get("monthly/2026-08.json.gz").options.customMetadata.format, "troom-diary-d1-v1");

const restoredDatabase = await migratedEmptyDatabase();
const restoreResult = await restoreDiaryBackup(new SqliteD1(restoredDatabase), readBackup(bucket, first.dailyKey));
assert.equal(restoreResult.complete, true);
assert.equal(restoredDatabase.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
assert.deepEqual(restoredDatabase.prepare("PRAGMA foreign_key_check").all(),[]);
const hundredTagBackup = structuredClone(readBackup(bucket, first.dailyKey));
hundredTagBackup.tables.diary_tags.rows = Array.from({ length: 100 }, (_, sort_order) => ({
  entry_id: 1, tag: `tag-${sort_order}`, created_at: "2026-08-20 00:00:00", sort_order
}));
hundredTagBackup.tables.diary_tags.rowCount = 100;
const hundredTagDatabase = await migratedEmptyDatabase();
const hundredTagRestore = await restoreDiaryBackup(new SqliteD1(hundredTagDatabase), hundredTagBackup);
assert.equal(hundredTagRestore.complete, true);
assert.deepEqual(hundredTagDatabase.prepare("SELECT tag FROM diary_tags WHERE entry_id = 1 ORDER BY sort_order ASC")
  .all().map((row) => row.tag), hundredTagBackup.tables.diary_tags.rows.map((row) => row.tag),
  "backup restore must preserve all 100 tags and their order");
for (const table of BACKUP_TABLES) {
  const restoredRows = restoredDatabase.prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.orderBy}`).all()
    .map((row) => ({ ...row }));
  assert.deepEqual(restoredRows, tableRows[table.name].map(r=>table.name === "diary_accounts" ? {...r,active:0}:r), `restored rows must match for ${table.name}`);
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

const version5Payload = structuredClone(readBackup(bucket, first.dailyKey));
version5Payload.formatVersion = 5;
version5Payload.tables.diary_entries.columns = version5Payload.tables.diary_entries.columns.filter((column) => column !== "last_published_at");
version5Payload.tables.diary_entries.rows = version5Payload.tables.diary_entries.rows.map(({ last_published_at, ...row }) => ({
  ...row,
  status: "published"
}));
const version5Database = await migratedEmptyDatabase();
await restoreDiaryBackup(new SqliteD1(version5Database), version5Payload);
assert.equal(
  version5Database.prepare("SELECT last_published_at FROM diary_entries LIMIT 1").get().last_published_at,
  "2026-08-20T00:00:00Z",
  "old backups derive a conservative UTC publication time"
);

const version4Payload = structuredClone(version5Payload);
version4Payload.formatVersion = 4;
version4Payload.tables.diary_entries.columns = version4Payload.tables.diary_entries.columns.filter((column) => column !== "entry_time");
version4Payload.tables.diary_entries.rows = version4Payload.tables.diary_entries.rows.map(({ entry_time, ...row }) => row);
const version4Database = await migratedEmptyDatabase();
await restoreDiaryBackup(new SqliteD1(version4Database), version4Payload);
assert.equal(version4Database.prepare("SELECT entry_time FROM diary_entries LIMIT 1").get().entry_time, null);
const version2Payload = structuredClone(version4Payload);
const version3Payload = structuredClone(version4Payload);
version3Payload.formatVersion = 3;
version3Payload.tables.diary_entries.columns = version3Payload.tables.diary_entries.columns.filter((column) => column !== "weather");
version3Payload.tables.diary_entries.rows = version3Payload.tables.diary_entries.rows.map(({ weather, ...row }) => row);
const version3Database = await migratedEmptyDatabase();
await restoreDiaryBackup(new SqliteD1(version3Database), version3Payload);
assert.equal(version3Database.prepare("SELECT weather FROM diary_entries LIMIT 1").get().weather, null);
version2Payload.tables.diary_entries = structuredClone(version3Payload.tables.diary_entries);
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

const photoBackup = await backupPhotos({ BACKUP: bucket, MEDIA: media }, tableRows.diary_photos, { now: nearUtcMidnight });
assert.equal(photoBackup.copied, 3);
const paired = await resolvePhotoManifest(bucket, readBackup(bucket, first.dailyKey));
const restoredMedia = new MemoryBucket();
const photoRestore = await restoreFormalPhotoObjects({ BACKUP: bucket, MEDIA: restoredMedia }, paired);
assert.deepEqual(photoRestore, { complete: true, restored: 3, existing: 0, missing: 0, failed: 0 });
for (const item of paired.mediaBackup.objects) assert.deepEqual(restoredMedia.objects.get(item.sourceKey).bytes, bucket.objects.get(item.backupKey).bytes);
assert.equal((await restoreFormalPhotoObjects({ BACKUP: bucket, MEDIA: restoredMedia }, paired)).existing, 3);
const legacyV7 = { ...paired, formatVersion: 7 };
assert.equal((await restoreFormalPhotoObjects({ BACKUP: bucket, MEDIA: new MemoryBucket() }, legacyV7)).complete, true);
const legacyV7Db = await migratedEmptyDatabase();
assert.equal((await restoreDiaryBackup(new SqliteD1(legacyV7Db), legacyV7)).complete, true);

const retryBucket = new MemoryBucket();
retryBucket.failMonthlyOnce = true;
const retryMedia = await createMediaFixture();
await assert.rejects(() => runDiaryBackup({ DB: createDb(), BACKUP: retryBucket, MEDIA: retryMedia }, { nowMs: nearUtcMidnight }), /monthly write failure/);
assert.equal([...retryBucket.objects.keys()].filter((key) => key.startsWith("v8/monthly/")).length, 0);
const retry = await runDiaryBackup({ DB: createDb(), BACKUP: retryBucket, MEDIA: retryMedia }, { nowMs: nearUtcMidnight + 86_400_000 });
assert.equal(retry.monthlyCreated, true, "a later successful run in the same month must create the missing monthly backup");
assert.equal([...retryBucket.objects.keys()].filter((key) => key.startsWith("v8/monthly/")).length, 1);

// Photo storage, inventory volume and failures cannot gate D1 or its retention.
for (const mode of ['absent','unavailable','many','empty']) {
  const db = createDb();
  if (mode === 'many') for (let i=0;i<1000;i++) await db.prepare('INSERT INTO diary_photos SELECT ?,entry_id,file_name,content_type,original_size,original_key || ?,display_key || ?,thumbnail_key || ?,width,height,created_by_id,created_by_name,created_at FROM diary_photos LIMIT 1').bind('many-'+i,'/'+i,'/'+i,'/'+i).run();
  if (mode === 'empty') await db.prepare('DELETE FROM diary_photos').run();
  const isolated = new MemoryBucket();
  await isolated.put('v7/daily/2026-07-31.json.gz', new Uint8Array([7]));
  const put = isolated.put.bind(isolated), get=isolated.get.bind(isolated), list=isolated.list.bind(isolated);
  isolated.get = key => { assert.ok(!key.startsWith('media/')); return get(key); };
  isolated.put = (key,...args) => { assert.ok(!key.startsWith('media/')); return put(key,...args); };
  isolated.list = options => { assert.ok(!options.prefix.startsWith('media/')); return list(options); };
  const forbidden = new Proxy({}, { get() { throw new Error('Photo access forbidden'); } });
  const result = await runDiaryBackup({ DB: db, BACKUP: isolated, MEDIA: forbidden }, { nowMs: nearUtcMidnight });
  assert.equal(result.complete, true, mode);
  assert.equal(isolated.objects.has('v7/daily/2026-07-31.json.gz'), true);
}
const retained = new MemoryBucket();
await retained.put('daily/2020-01-01.json.gz',new Uint8Array([1]));
await retained.put('v7/monthly/2020-01.json.gz',new Uint8Array([2]));
for (let i=0;i<32;i++) await runDiaryBackup({ DB:createDb(), BACKUP:retained }, {nowMs:nearUtcMidnight+i*86400000});
assert.equal([...retained.objects.keys()].filter(k=>k.startsWith('v8/daily/')).length,30);
for(let i=0;i<13;i++) await runDiaryBackup({ DB:createDb(), BACKUP:retained }, {nowMs:Date.UTC(2024, i, 15)});
assert.equal([...retained.objects.keys()].filter(k=>k.startsWith('v8/monthly/')).length,12);
assert.ok(retained.objects.has('daily/2020-01-01.json.gz'));
assert.ok(retained.objects.has('v7/monthly/2020-01.json.gz'));

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
assert.deepEqual(wrangler.triggers.crons, ["25 18 * * *", "55 18 * * *", "45 0-2,19-23 * * *", "5,15,25,35,55 19,20 * * *"]);
assert.ok(wrangler.r2_buckets.some((binding) => binding.binding === "MEDIA" && binding.bucket_name === "t-room-diary-media"));
assert.ok(wrangler.r2_buckets.some((binding) => binding.binding === "BACKUP" && binding.bucket_name === "t-room-diary-backups"));
assert.match(workerSource, /runScheduledDiaryBackup/);
assert.match(workerSource, /runScheduledMediaDeletionCleanup/);
assert.doesNotMatch(workerSource, /\/api\/backup/i, "backup objects must not be exposed through a diary API");

process.stdout.write(`Diary backup tests passed (${first.compressedBytes} compressed bytes in fixture).\n`);
