const BACKUP_FORMAT_VERSION = 3;
const LEGACY_BACKUP_FORMAT_VERSION = 2;
const DAILY_RETENTION = 30;
const MONTHLY_RETENTION = 12;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAILY_PREFIX = "daily/";
const MONTHLY_PREFIX = "monthly/";
const PHOTO_BACKUP_PREFIX = "media/formal-photos/";
// Formal photo copies are content-addressed by the immutable photo ID and are
// intentionally outside daily/monthly pruning. Historical D1 generations can
// otherwise outlive the media needed to restore them. Staging-only objects are
// never copied into this prefix.
const PHOTO_VARIANTS = Object.freeze([
  ["original", "original_key"],
  ["display", "display_key"],
  ["thumbnail", "thumbnail_key"]
]);

const BACKUP_TABLES = [
  {
    name: "diary_entries",
    columns: [
      "id", "entry_date", "title", "content", "created_at", "updated_at", "deleted_at", "revision",
      "author_id", "author_name", "deleted_by_id", "deleted_by_name", "household_id", "content_format",
      "status", "draft_of_entry_id", "draft_of_revision", "draft_excluded_photo_ids",
      "client_request_id", "client_request_hash", "last_mutation_id"
    ],
    orderBy: "id ASC"
  },
  {
    name: "diary_tags",
    columns: ["entry_id", "tag", "created_at", "sort_order"],
    orderBy: "entry_id ASC, sort_order ASC"
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
  },
  {
    name: "investment_history",
    columns: [
      "recorded_at", "total", "cash", "stocks", "funds", "bonds", "crypto", "futures",
      "points", "other", "updated_at"
    ],
    orderBy: "recorded_at ASC"
  }
];

const RESTORE_TABLE_ORDER = Object.freeze([
  "diary_accounts",
  "diary_entries",
  "diary_tags",
  "diary_photos",
  "diary_trash_scopes",
  "diary_favorites",
  "investment_history"
]);

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
  const mediaBackup = await backupFormalPhotoObjects(env, payload.tables.diary_photos.rows);
  payload.mediaBackup = {
    formatVersion: 1,
    prefix: PHOTO_BACKUP_PREFIX,
    formalPhotoCount: payload.tables.diary_photos.rowCount,
    expectedObjectCount: payload.tables.diary_photos.rowCount * PHOTO_VARIANTS.length,
    copiedObjectCount: mediaBackup.copied,
    existingObjectCount: mediaBackup.existing,
    missingSourceObjectCount: mediaBackup.missing,
    failedObjectCount: mediaBackup.failed,
    complete: mediaBackup.complete
  };
  const compressed = await gzipJson(payload);
  const putOptions = {
    httpMetadata: {
      contentType: "application/json",
      contentEncoding: "gzip"
    },
    customMetadata: {
      format: `troom-diary-d1-v${BACKUP_FORMAT_VERSION}`,
      japanDate: keys.date,
      source: "diary-db",
      mediaComplete: mediaBackup.complete ? "true" : "false"
    }
  };

  await env.BACKUP.put(keys.daily, compressed, putOptions);
  const monthlyHead = await env.BACKUP.head(keys.monthly);
  let monthlyCreated = false;
  let monthlyUpgraded = false;
  if (!monthlyHead || monthlyHead.customMetadata?.format !== `troom-diary-d1-v${BACKUP_FORMAT_VERSION}`) {
    await env.BACKUP.put(keys.monthly, compressed, putOptions);
    monthlyCreated = !monthlyHead;
    monthlyUpgraded = Boolean(monthlyHead);
  }

  const [dailyRetention, monthlyRetention] = await Promise.all([
    pruneBackupGenerations(env.BACKUP, DAILY_PREFIX, DAILY_RETENTION),
    pruneBackupGenerations(env.BACKUP, MONTHLY_PREFIX, MONTHLY_RETENTION)
  ]);
  return {
    complete: mediaBackup.complete,
    dailyKey: keys.daily,
    monthlyKey: keys.monthly,
    monthlyCreated,
    monthlyUpgraded,
    compressedBytes: compressed.byteLength,
    rowCounts: Object.fromEntries(Object.entries(payload.tables).map(([name, table]) => [name, table.rowCount])),
    mediaBackup,
    deletedDaily: dailyRetention.deleted,
    deletedMonthly: monthlyRetention.deleted
  };
}

async function runScheduledDiaryBackup(env, nowMs = Date.now()) {
  try {
    const result = await runDiaryBackup(env, { nowMs });
    if (!result.complete) {
      console.error(JSON.stringify({
        event: "diary_photo_backup_incomplete",
        missingObjectCount: result.mediaBackup.missing,
        failedObjectCount: result.mediaBackup.failed
      }));
    }
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      event: "diary_backup_failed",
      errorType: backupErrorType(error)
    }));
    return { complete: false, error: true };
  }
}

function formalPhotoBackupKey(photoId, variant) {
  return `${PHOTO_BACKUP_PREFIX}${encodeURIComponent(String(photoId))}/${variant}`;
}

async function backupFormalPhotoObjects(env, photoRows) {
  if (!photoRows.length) return { complete: true, copied: 0, existing: 0, missing: 0, failed: 0 };
  if (!env.MEDIA) throw new Error("Media bucket binding is unavailable");
  const existingKeys = new Set((await listAllBackupObjects(env.BACKUP, PHOTO_BACKUP_PREFIX)).map((object) => object.key));
  const result = { complete: true, copied: 0, existing: 0, missing: 0, failed: 0 };
  for (const photo of photoRows) {
    for (const [variant, sourceColumn] of PHOTO_VARIANTS) {
      const destinationKey = formalPhotoBackupKey(photo.id, variant);
      if (existingKeys.has(destinationKey)) {
        result.existing += 1;
        continue;
      }
      try {
        const source = await env.MEDIA.get(photo[sourceColumn]);
        if (!source) {
          result.missing += 1;
          continue;
        }
        await env.BACKUP.put(destinationKey, source.body, {
          ...(source.httpMetadata ? { httpMetadata: source.httpMetadata } : {}),
          customMetadata: {
            photoId: String(photo.id),
            variant,
            sourceKey: String(photo[sourceColumn])
          }
        });
        existingKeys.add(destinationKey);
        result.copied += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  result.complete = result.missing === 0 && result.failed === 0;
  return result;
}

async function restoreFormalPhotoObjects(env, payload) {
  if (!env?.BACKUP || !env?.MEDIA) throw new Error("R2 bindings are unavailable");
  validateBackupPayload(payload);
  const photos = payload.tables.diary_photos.rows;
  const result = { complete: true, restored: 0, existing: 0, missing: 0, failed: 0 };
  for (const photo of photos) {
    for (const [variant, destinationColumn] of PHOTO_VARIANTS) {
      const destinationKey = String(photo[destinationColumn] || "");
      if (!destinationKey) {
        result.missing += 1;
        continue;
      }
      if (await env.MEDIA.head(destinationKey)) {
        result.existing += 1;
        continue;
      }
      try {
        const source = await env.BACKUP.get(formalPhotoBackupKey(photo.id, variant));
        if (!source) {
          result.missing += 1;
          continue;
        }
        await env.MEDIA.put(destinationKey, source.body, {
          ...(source.httpMetadata ? { httpMetadata: source.httpMetadata } : {})
        });
        result.restored += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  result.complete = result.missing === 0 && result.failed === 0;
  return result;
}

async function gunzipJson(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

async function restoreDiaryBackup(db, payload, { batchSize = 100 } = {}) {
  if (!db) throw new Error("D1 binding is unavailable");
  validateBackupPayload(payload);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("Invalid restore batch size");
  const configuredTables = new Map(BACKUP_TABLES.map((table) => [table.name, table]));
  const countResults = await db.batch(RESTORE_TABLE_ORDER.map((name) => db.prepare(`SELECT COUNT(*) AS count FROM ${name}`)));
  if (countResults.some((result) => Number(result?.results?.[0]?.count || 0) !== 0)) {
    throw new Error("Restore target must be empty");
  }

  const restored = {};
  for (const name of RESTORE_TABLE_ORDER) {
    const expected = configuredTables.get(name);
    const table = restoreTable(payload, name, expected);
    const restoreColumns = name === "diary_accounts"
      ? [...expected.columns, "login_id", "password_hash", "must_change_password", "session_version"]
      : expected.columns;
    const statements = table.rows.map((row) => {
      const values = expected.columns.map((column) => row[column] ?? null);
      if (name === "diary_accounts") {
        const safeId = String(row.id || "account").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
        values.push(`restored-${safeId}@invalid.local`, null, 1, 1);
      }
      return db.prepare(`
        INSERT INTO ${name} (${restoreColumns.join(", ")})
        VALUES (${restoreColumns.map(() => "?").join(", ")})
      `).bind(...values);
    });
    for (let offset = 0; offset < statements.length; offset += batchSize) {
      await db.batch(statements.slice(offset, offset + batchSize));
    }
    restored[name] = statements.length;
  }
  return { complete: true, restored };
}

function validateBackupPayload(payload) {
  const formatVersion = Number(payload?.formatVersion);
  if (!payload || ![LEGACY_BACKUP_FORMAT_VERSION, BACKUP_FORMAT_VERSION].includes(formatVersion) || !payload.tables) {
    throw new Error("Unsupported diary backup format");
  }
}

function restoreTable(payload, name, expected) {
  const table = payload.tables[name];
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    throw new Error(`Backup table is missing: ${name}`);
  }
  if (Number(payload.formatVersion) === LEGACY_BACKUP_FORMAT_VERSION && name === "diary_tags") {
    const legacyColumns = ["entry_id", "tag", "created_at"];
    if (JSON.stringify(table.columns) !== JSON.stringify(legacyColumns)) {
      throw new Error(`Backup columns do not match: ${name}`);
    }
    const nextSortOrder = new Map();
    return {
      ...table,
      columns: expected.columns,
      rows: table.rows.map((row) => {
        const entryId = String(row.entry_id);
        const sortOrder = nextSortOrder.get(entryId) || 0;
        nextSortOrder.set(entryId, sortOrder + 1);
        return { ...row, sort_order: sortOrder };
      })
    };
  }
  if (JSON.stringify(table.columns) !== JSON.stringify(expected.columns)) {
    throw new Error(`Backup columns do not match: ${name}`);
  }
  return table;
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

function backupErrorType(error) {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  return error instanceof Error ? "Error" : "UnknownError";
}

export {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  DAILY_RETENTION,
  MONTHLY_RETENTION,
  PHOTO_BACKUP_PREFIX,
  backupFormalPhotoObjects,
  backupKeys,
  createDiaryBackupPayload,
  formalPhotoBackupKey,
  gunzipJson,
  gzipJson,
  isManagedBackupKey,
  japanCalendar,
  pruneBackupGenerations,
  restoreDiaryBackup,
  restoreFormalPhotoObjects,
  runDiaryBackup,
  runScheduledDiaryBackup,
  scheduleIndependentTasks
};
