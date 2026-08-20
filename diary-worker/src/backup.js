const BACKUP_FORMAT_VERSION = 1;
const DAILY_RETENTION = 30;
const MONTHLY_RETENTION = 12;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAILY_PREFIX = "daily/";
const MONTHLY_PREFIX = "monthly/";

const BACKUP_TABLES = [
  {
    name: "diary_entries",
    columns: [
      "id", "entry_date", "title", "content", "created_at", "updated_at", "deleted_at", "revision",
      "author_id", "author_name", "deleted_by_id", "deleted_by_name", "household_id", "content_format",
      "status", "draft_of_entry_id", "draft_of_revision", "draft_excluded_photo_ids"
    ],
    orderBy: "id ASC"
  },
  {
    name: "diary_tags",
    columns: ["entry_id", "tag", "created_at"],
    orderBy: "entry_id ASC, tag ASC"
  },
  {
    name: "diary_photos",
    columns: [
      "id", "entry_id", "file_name", "content_type", "original_size", "original_key", "display_key",
      "thumbnail_key", "width", "height", "created_by_id", "created_by_name", "created_at"
    ],
    orderBy: "entry_id ASC, created_at ASC, id ASC"
  },
  {
    name: "diary_trash_scopes",
    columns: [
      "id", "entry_id", "owner_account_id", "household_id", "scope_type", "entry_revision",
      "deleted_by_id", "deleted_at", "created_at"
    ],
    orderBy: "id ASC"
  },
  {
    name: "diary_favorites",
    columns: ["account_id", "entry_id", "created_at"],
    orderBy: "account_id ASC, entry_id ASC"
  },
  {
    name: "diary_accounts",
    columns: [
      "id", "household_id", "display_name", "role", "can_manage_entries", "can_view_trash",
      "can_permanently_delete", "can_view_investment", "active", "created_at", "updated_at"
    ],
    orderBy: "id ASC"
  }
];

function japanCalendar(nowMs = Date.now()) {
  const iso = new Date(nowMs + JST_OFFSET_MS).toISOString();
  const date = iso.slice(0, 10);
  return { date, month: date.slice(0, 7) };
}

function backupKeys(nowMs = Date.now()) {
  const calendar = japanCalendar(nowMs);
  return {
    ...calendar,
    daily: `${DAILY_PREFIX}${calendar.date}.json.gz`,
    monthly: `${MONTHLY_PREFIX}${calendar.month}.json.gz`
  };
}

async function createDiaryBackupPayload(db, nowMs = Date.now()) {
  if (!db) throw new Error("D1 binding is unavailable");
  const statements = BACKUP_TABLES.map((table) => db.prepare(
    `SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.orderBy}`
  ));
  const results = await db.batch(statements);
  const tables = {};
  for (let index = 0; index < BACKUP_TABLES.length; index += 1) {
    const table = BACKUP_TABLES[index];
    const rows = results[index]?.results || [];
    tables[table.name] = {
      columns: table.columns,
      rowCount: rows.length,
      rows
    };
  }
  const calendar = japanCalendar(nowMs);
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    japanDate: calendar.date,
    source: {
      service: "t-room-diary",
      database: "diary-db",
      binding: "DB"
    },
    tableOrder: BACKUP_TABLES.map((table) => table.name),
    tables
  };
}

async function gzipJson(value) {
  const source = new Blob([JSON.stringify(value)], { type: "application/json" }).stream();
  const compressed = source.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function runDiaryBackup(env, { nowMs = Date.now() } = {}) {
  if (!env?.BACKUP) throw new Error("Backup bucket binding is unavailable");
  const keys = backupKeys(nowMs);
  const payload = await createDiaryBackupPayload(env.DB, nowMs);
  const compressed = await gzipJson(payload);
  const putOptions = {
    httpMetadata: {
      contentType: "application/json",
      contentEncoding: "gzip"
    },
    customMetadata: {
      format: `troom-diary-d1-v${BACKUP_FORMAT_VERSION}`,
      japanDate: keys.date,
      source: "diary-db"
    }
  };

  await env.BACKUP.put(keys.daily, compressed, putOptions);
  let monthlyCreated = false;
  if (!await env.BACKUP.head(keys.monthly)) {
    await env.BACKUP.put(keys.monthly, compressed, putOptions);
    monthlyCreated = true;
  }

  const [dailyRetention, monthlyRetention] = await Promise.all([
    pruneBackupGenerations(env.BACKUP, DAILY_PREFIX, DAILY_RETENTION),
    pruneBackupGenerations(env.BACKUP, MONTHLY_PREFIX, MONTHLY_RETENTION)
  ]);
  return {
    complete: true,
    dailyKey: keys.daily,
    monthlyKey: keys.monthly,
    monthlyCreated,
    compressedBytes: compressed.byteLength,
    rowCounts: Object.fromEntries(Object.entries(payload.tables).map(([name, table]) => [name, table.rowCount])),
    deletedDaily: dailyRetention.deleted,
    deletedMonthly: monthlyRetention.deleted
  };
}

async function runScheduledDiaryBackup(env, nowMs = Date.now()) {
  try {
    return await runDiaryBackup(env, { nowMs });
  } catch (error) {
    console.error(JSON.stringify({
      event: "diary_backup_failed",
      error: backupErrorMessage(error)
    }));
    return { complete: false, error: true };
  }
}

function scheduleIndependentTasks(context, tasks) {
  for (const task of tasks) context.waitUntil(Promise.resolve().then(task));
}

async function pruneBackupGenerations(bucket, prefix, retention) {
  if (prefix !== DAILY_PREFIX && prefix !== MONTHLY_PREFIX) throw new Error("Unsupported backup prefix");
  const objects = await listAllBackupObjects(bucket, prefix);
  const valid = objects.filter((object) => isManagedBackupKey(object.key, prefix));
  valid.sort((left, right) => right.key.localeCompare(left.key));
  const obsolete = valid.slice(retention).map((object) => object.key);
  for (let offset = 0; offset < obsolete.length; offset += 1000) {
    await bucket.delete(obsolete.slice(offset, offset + 1000));
  }
  return { kept: Math.min(valid.length, retention), deleted: obsolete.length };
}

async function listAllBackupObjects(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function isManagedBackupKey(key, prefix) {
  if (prefix === DAILY_PREFIX) {
    const match = /^daily\/(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(key);
    if (!match) return false;
    const parsed = new Date(`${match[1]}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1];
  }
  if (prefix === MONTHLY_PREFIX) {
    const match = /^monthly\/(\d{4})-(\d{2})\.json\.gz$/.exec(key);
    return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
  }
  return false;
}

function backupErrorMessage(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "unknown error");
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, "$1 [redacted]")
    .slice(0, 300);
}

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  DAILY_RETENTION,
  MONTHLY_RETENTION,
  backupKeys,
  createDiaryBackupPayload,
  gzipJson,
  isManagedBackupKey,
  japanCalendar,
  pruneBackupGenerations,
  runDiaryBackup,
  runScheduledDiaryBackup,
  scheduleIndependentTasks
};
