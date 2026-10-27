import { compress, decode, publishGeneration, withBackupLock } from '../../backup-worker/src/integrity.js';
import { snapshotStatement, snapshotTables } from '../../backup-worker/src/snapshot.js';
import { backupPhotos, restorePhotos, validatePhotoManifest } from './photo-backup.js';
import { prune as pruneVerified } from '../../backup-worker/src/backup.js';
import { reportRun } from '../../backup-worker/src/monitor.js';
import { assertSchema } from '../../backup-worker/src/schema-guard.js';
const BACKUP_FORMAT_VERSION = 7;
const LEGACY_BACKUP_FORMAT_VERSION = 2;
const DAILY_RETENTION = 30;
const MONTHLY_RETENTION = 12;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAILY_PREFIX = "daily/";
const MONTHLY_PREFIX = "monthly/";
const PHOTO_BACKUP_PREFIX = "media/formal-photos/";
// Legacy photo namespace, retained for compatibility only. New writes use
// SHA-addressed objects in photo-backup.js and never prune historical photos.
const PHOTO_VARIANTS = Object.freeze([
  ["original", "original_key"],
  ["display", "display_key"],
  ["thumbnail", "thumbnail_key"]
]);

const BACKUP_TABLES = [
  {
    name: "diary_entries",
    columns: [
      "id", "entry_date", "last_published_at", "entry_time", "title", "content", "created_at", "updated_at", "deleted_at", "revision",
      "author_id", "author_name", "deleted_by_id", "deleted_by_name", "household_id", "content_format",
      "status", "draft_of_entry_id", "draft_of_revision", "draft_excluded_photo_ids",
      "client_request_id", "client_request_hash", "last_mutation_id", "weather"
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
    daily: `v7/${DAILY_PREFIX}${calendar.date}.json.gz`,
    monthly: `v7/${MONTHLY_PREFIX}${calendar.month}.json.gz`
  };
}

async function createDiaryBackupPayload(db, nowMs = Date.now()) {
  if (!db) throw new Error("D1 binding is unavailable");
  const startedAt = new Date().toISOString();
  const result = await db.batch([snapshotStatement(db, BACKUP_TABLES),
    ...BACKUP_TABLES.map(t => db.prepare(`SELECT name FROM pragma_table_info('${t.name}')`)),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name")]);
  for (let i=0;i<BACKUP_TABLES.length;i++) {
    const t=BACKUP_TABLES[i], excluded=t.name==='diary_accounts'?['login_id','password_hash','must_change_password','session_version']:[];
    if (result[i+1].results.map(c=>c.name).sort().join(',') !== [...t.columns,...excluded].sort().join(',')) throw new Error('SchemaReviewRequired');
  }
  const known = [...BACKUP_TABLES.map(t=>t.name),'diary_login_attempts','diary_media_deletion_queue','diary_photo_upload_sessions','diary_staged_photos','password_auth_policy','password_auth_policy_audit','d1_migrations'];
  if (result.at(-1).results.some(t=>t.type==='table' && !known.includes(t.name))) throw new Error('SchemaReviewRequired');
  await assertSchema('diary',result.at(-1).results);
  const tables = snapshotTables(result[0]);
  const calendar = japanCalendar(nowMs);
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: startedAt, completedAt: new Date().toISOString(), scheduledFor: new Date(nowMs).toISOString(), consistency: 'single-database-transaction',
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

const gzipJson = compress;

async function runDiaryBackup(env, { nowMs = Date.now() } = {}) {
  return withBackupLock(() => runDiaryBackupUnlocked(env, nowMs));
}
async function runDiaryBackupUnlocked(env, nowMs) {
  if (!env?.BACKUP) throw new Error("Backup bucket binding is unavailable");
  const keys = backupKeys(nowMs);
  const payload = await createDiaryBackupPayload(env.DB, nowMs);
  const mediaBackup = await backupPhotos(env, payload.tables.diary_photos.rows, { now: nowMs });
  payload.mediaBackup = {
    formatVersion: 2,
    objects: mediaBackup.objects,
    oldestVerifiedAt: mediaBackup.oldestVerifiedAt,
    prefix: 'media/verified-photos/',
    formalPhotoCount: payload.tables.diary_photos.rowCount,
    expectedObjectCount: payload.tables.diary_photos.rowCount * PHOTO_VARIANTS.length,
    copiedObjectCount: mediaBackup.copied,
    existingObjectCount: mediaBackup.existing,
    missingSourceObjectCount: mediaBackup.missing,
    failedObjectCount: mediaBackup.failed,
    pendingObjectCount: mediaBackup.pending,
    complete: mediaBackup.complete
  };
  if (!mediaBackup.complete) return { complete: false, mediaBackup, dailyKey: keys.daily, monthlyKey: keys.monthly };
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

  const validate = validateGeneration;
  const saved = await publishGeneration(env.BACKUP, keys.daily, compressed, putOptions.customMetadata, validate);
  const monthly = await publishGeneration(env.BACKUP, keys.monthly, saved.bytes, putOptions.customMetadata, validate);
  const monthlyCreated = monthly.created, monthlyUpgraded = false;
  let dailyRetention = { deleted: 0 }, monthlyRetention = { deleted: 0 }, retentionFailed = false;
  try {
    [dailyRetention, monthlyRetention] = await Promise.all([
      pruneVerified(env.BACKUP, 'v7/daily/', DAILY_RETENTION, validate).then(deleted => ({ deleted })),
      pruneVerified(env.BACKUP, 'v7/monthly/', MONTHLY_RETENTION, validate).then(deleted => ({ deleted }))
    ]);
  } catch { retentionFailed = true; }
  return {
    complete: mediaBackup.complete,
    retentionFailed,
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

async function runScheduledDiaryBackup(env, nowMs = Date.now(), { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const runId = crypto.randomUUID();
  await reportRun(env, 'diary', runId, 'started', {}, nowMs);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await runDiaryBackup(env, { nowMs });
      if ((!result.complete || result.retentionFailed) && attempt < 3) { await sleep(attempt * 1000); continue; }
      await reportRun(env, 'diary', runId, result.complete ? 'succeeded' : 'partial', {
        attempt, ...(result.complete ? { bytes: result.compressedBytes } : { stage: 'photos', reason: 'media_incomplete', pending: result.mediaBackup.pending })
      });
      if (result.retentionFailed) await reportRun(env, 'diary', runId, 'prune_failed', { attempt, stage: 'retention', reason: 'retention_failed' });
      if (!result.complete) console.error(JSON.stringify({ event: 'diary_photo_backup_incomplete', missingObjectCount: result.mediaBackup.missing, failedObjectCount: result.mediaBackup.failed }));
      return result;
    } catch (error) {
      const reasons={SchemaReviewRequired:'schema_review_required',SnapshotTooLarge:'snapshot_too_large',UnsafeInteger:'unsafe_integer',LegacyGenerationUnverified:'legacy_unverified',VerificationFailed:'verification_failed',SnapshotInvalid:'verification_failed',MediaManifestInvalid:'verification_failed',ConcurrentWrite:'concurrent_write'};
      if (attempt < 3 && !['SchemaReviewRequired','SnapshotTooLarge','UnsafeInteger','LegacyGenerationUnverified'].includes(error?.message)) { await sleep(attempt * 1000); continue; }
      await reportRun(env, 'diary', runId, 'failed', { attempt, stage: 'save_or_retention', reason: reasons[error?.message] || 'operation_failed' });
      console.error(JSON.stringify({ event: 'diary_backup_failed', errorType: backupErrorType(error) }));
      return { complete: false, error: true };
    }
  }
}

function formalPhotoBackupKey(photoId, variant) {
  return `${PHOTO_BACKUP_PREFIX}${encodeURIComponent(String(photoId))}/${variant}`;
}

async function backupFormalPhotoObjects(env, rows) { return backupPhotos(env, rows); }
async function restoreFormalPhotoObjects(env, payload) { validateBackupPayload(payload); return restorePhotos(env, payload); }

async function gunzipJson(source) {
  return decode(source instanceof Uint8Array ? source : new Uint8Array(source));
}

function validateGeneration(p) {
  validateBackupPayload(p);
  if (p.formatVersion !== 7 || p.source?.database !== 'diary-db' || p.mediaBackup?.complete !== true || !Array.isArray(p.mediaBackup?.objects)
    || Object.keys(p.tables).sort().join(',') !== BACKUP_TABLES.map(t=>t.name).sort().join(',')) throw new Error('SnapshotInvalid');
  for (const t of BACKUP_TABLES) {
    const table=p.tables[t.name];
    if (JSON.stringify(table.columns)!==JSON.stringify(t.columns) || !Array.isArray(table.rows) || table.rowCount!==table.rows.length
      || table.rows.some(r=>!r || Object.keys(r).sort().join(',')!==[...t.columns].sort().join(','))) throw new Error('SnapshotInvalid');
  }
  if(p.mediaBackup.objects.length!==p.tables.diary_photos.rows.length*3) throw new Error('MediaManifestInvalid');
  validatePhotoManifest(p);
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
      // Restored accounts require deliberate re-authorization. Old cookies and
      // still-existing service links must not revive archived permissions.
      const values = expected.columns.map((column) => name === 'diary_accounts' && column === 'active' ? 0 : row[column] ?? null);
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
  if (!payload || ![LEGACY_BACKUP_FORMAT_VERSION, 3, 4, 5, 6, BACKUP_FORMAT_VERSION].includes(formatVersion) || !payload.tables) {
    throw new Error("Unsupported diary backup format");
  }
}

function restoreTable(payload, name, expected) {
  const table = payload.tables[name];
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    throw new Error(`Backup table is missing: ${name}`);
  }
  if (name === "diary_entries") {
    const optionalColumns = new Set(["last_published_at", "entry_time", "weather"]);
    const presentColumns = new Set(table.columns);
    const omitted = expected.columns.filter((column) => !presentColumns.has(column));
    const expectedPresentColumns = expected.columns.filter((column) => presentColumns.has(column));
    if (omitted.every((column) => optionalColumns.has(column))
      && JSON.stringify(table.columns) === JSON.stringify(expectedPresentColumns)) {
      return {
        ...table,
        columns: expected.columns,
        rows: table.rows.map((row) => ({
          ...row,
          ...(omitted.includes("last_published_at") ? { last_published_at: legacyLastPublishedAt(row) } : {}),
          ...(omitted.includes("entry_time") ? { entry_time: null } : {}),
          ...(omitted.includes("weather") ? { weather: null } : {})
        }))
      };
    }
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

function legacyLastPublishedAt(row) {
  if (String(row.status || "published") !== "published") return null;
  const createdAt = String(row.created_at || "");
  const updatedAt = String(row.updated_at || "");
  const deletionOverwroteUpdate = row.deleted_at != null && String(row.deleted_at) === updatedAt;
  const source = Number(row.revision || 1) <= 1 || updatedAt === createdAt || deletionOverwroteUpdate
    ? createdAt
    : updatedAt;
  if (!source) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(source)) return source;
  return `${source.replace(" ", "T")}Z`;
}

function scheduleIndependentTasks(context, tasks) {
  for (const task of tasks) context.waitUntil(Promise.resolve().then(task));
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
  japanCalendar,
  restoreDiaryBackup,
  restoreFormalPhotoObjects,
  runDiaryBackup,
  runScheduledDiaryBackup,
  scheduleIndependentTasks
};
