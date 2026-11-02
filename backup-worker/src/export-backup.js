import { SERVICES } from './registry.js';
import { BACKUP_TABLES } from '../../diary-worker/src/backup.js';
import { assertSchema } from './schema-guard.js';
import { compress, decode, digest, verifiedPut, verifiedGeneration } from './integrity.js';
import { sqlStatements, exportedRows } from './export-sql.js';
import { listObjects } from './backup.js';

const FORMAT = 'troom-d1-export-v3';
const PART_BYTES = 1024 * 1024;
const MAX_PARTS = 20000;
const UUID = /^[a-f0-9-]{36}$/;
export const DATABASES = {
  cloud: 'd536bdb7-c3b4-46df-bdc5-f9ea4f00c4cd', security: '45c2e1ff-8ee1-4cc8-b8e5-cacc0846e475',
  billing: '8ed4cb80-44ca-4449-bfb4-bb38f3191bde', payments: '066196b0-25d4-4c92-acfd-066dae61530b',
  health: '620aa524-b2f8-400a-ad53-cb505618a9af', inventory: 'e47d0a7f-7c1b-44b4-98ea-e5db030acd86',
  ai: '94d336e3-66c9-4e45-ae23-6ee34a602b05', downloader: '1e047091-e838-4ec3-899d-62014b283660',
  calendar: 'f9ad73f1-92df-40ef-a363-cf328123589d', household: 'cb41cbc5-53c8-4868-95e1-94d92b7b5289',
  diary: 'e4677259-db4b-4562-ad82-fe542a1edb75', portfolio: '8fd0d41b-8ce2-42b8-a2e8-8c4461d08b32'
};

export function exportSpec(service) {
  if (service === 'diary') return { database: 'diary-db', binding: 'DIARY_DB', migration: '0022_photo_backup_identity.sql',
    tables: BACKUP_TABLES.map(t => ({ ...t, sourceColumns: t.columns.join(',') })) };
  if (!Object.hasOwn(SERVICES, service)) throw new Error('SourceUnavailable');
  return SERVICES[service];
}
export const exportBucket = (env, service) => service === 'diary' ? env.DIARY_BACKUP : env.BACKUP;
export const exportPrefix = service => service === 'diary' ? 'v9/' : `d1/${service}/v3/`;
export const exportDay = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);

async function schemaMetadata(db, service, spec) {
  const results = await db.batch([
    ...spec.tables.map(t => db.prepare(`SELECT name FROM pragma_table_info('${t.name}') ORDER BY cid`)),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name")
  ]);
  if (results.some(r => r.success === false)) throw new Error('SourceUnavailable');
  const tables = spec.tables.map((t, i) => {
    const actual = results[i].results.map(c => c.name);
    const excluded = t.name === 'diary_accounts' ? ['login_id','password_hash','must_change_password','session_version'] : [];
    const expected = service === 'diary' ? [...t.columns, ...excluded] : t.sourceColumns.split(',');
    if ([...actual].sort().join(',') !== [...expected].sort().join(',')) throw new Error('SchemaReviewRequired');
    return { name: t.name, columns: t.columns, sourceColumns: actual.join(',') };
  });
  const schema = results.at(-1).results;
  await assertSchema(service, schema);
  return { tables, schema };
}

async function exportRequest(env, service, body, fetcher) {
  if (!/^[a-f0-9]{32}$/.test(env.D1_EXPORT_ACCOUNT_ID || '') || !env.D1_EXPORT_API_TOKEN) throw new Error('ExportUnavailable');
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.D1_EXPORT_ACCOUNT_ID}/d1/database/${DATABASES[service]}/export`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${env.D1_EXPORT_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error('ExportUnavailable');
  const data = await response.json();
  if (!data.success || data.result?.status === 'error' || data.result?.error) throw new Error('ExportUnavailable');
  return data.result;
}

async function openExport(env, service, tables, fetcher, sleep) {
  const dump_options = { no_schema: true, tables: tables.map(t => t.name) };
  let result = await exportRequest(env, service, { output_format: 'polling', dump_options }, fetcher);
  const bookmark = result.at_bookmark;
  if (typeof bookmark !== 'string' || !bookmark || bookmark.length > 256) throw new Error('ExportUnavailable');
  for (let attempt = 0; attempt < 120; attempt++) {
    // Do not return/persist signed URLs in Workflow results, logs or manifests.
    const signed = result.result?.signed_url;
    if (result.status === 'complete' && signed) {
      const url = new URL(signed);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('ExportUnavailable');
      const response = await fetcher(url.href, { redirect: 'error' });
      if (!response.ok || !response.body) throw new Error('ExportUnavailable');
      return { body: response.body, bookmark };
    }
    if (result.status && !['active','complete'].includes(result.status)) throw new Error('ExportUnavailable');
    await sleep(Math.min(1000 + attempt * 250, 5000));
    result = await exportRequest(env, service, { output_format: 'polling', dump_options, current_bookmark: bookmark }, fetcher);
    if (result.at_bookmark && result.at_bookmark !== bookmark) throw new Error('ExportInvalid');
  }
  throw new Error('ExportTimeout');
}

export function validateExportManifest(manifest, service) {
  const spec = exportSpec(service), prefix = exportPrefix(service);
  if (manifest?.format !== FORMAT || manifest.service !== service || manifest.database !== spec.database || manifest.expectedMigration !== spec.migration
    || manifest.consistency !== 'single-database-export' || !Number.isFinite(Date.parse(manifest.scheduledFor))
    || !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(manifest.completedAt))
    || typeof manifest.bookmark !== 'string' || !manifest.bookmark || manifest.bookmark.length > 256
    || !Array.isArray(manifest.schema) || !Array.isArray(manifest.parts) || manifest.parts.length > MAX_PARTS
    || Object.keys(manifest.tables || {}).sort().join(',') !== spec.tables.map(t => t.name).sort().join(',')) throw new Error('SnapshotInvalid');
  const counts = Object.fromEntries(spec.tables.map(t => [t.name, 0]));
  const keys = new Set(); let bytes = 0;
  for (const part of manifest.parts) {
    if (!part || !part.key?.startsWith(prefix + 'data/') || !new RegExp(`^${prefix}data/[a-f0-9-]{36}/[0-9]{6}\\.json\\.gz$`).test(part.key)
      || keys.has(part.key) || !Object.hasOwn(counts, part.table) || !/^[a-f0-9]{64}$/.test(part.sha256)
      || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > 16 * 1024 * 1024
      || !Number.isSafeInteger(part.rowCount) || part.rowCount <= 0) throw new Error('SnapshotInvalid');
    keys.add(part.key); counts[part.table] += part.rowCount; bytes += part.bytes;
  }
  for (const t of spec.tables) {
    const stored = manifest.tables[t.name];
    if (JSON.stringify(stored.columns) !== JSON.stringify(t.columns) || stored.rowCount !== counts[t.name]) throw new Error('SnapshotInvalid');
  }
  if (manifest.bytes !== bytes || manifest.rowCount !== Object.values(counts).reduce((a,b) => a+b,0)) throw new Error('SnapshotInvalid');
}

export async function* readExportParts(bucket, manifest, service) {
  validateExportManifest(manifest, service);
  for (const part of manifest.parts) {
    const verified = await verifiedGeneration(bucket, part.key, p => {
      if (p?.table !== part.table || !Array.isArray(p.rows) || p.rows.length !== part.rowCount) throw new Error('VerificationFailed');
      const columns = manifest.tables[part.table].columns;
      if (p.rows.some(row => !row || Object.keys(row).sort().join(',') !== [...columns].sort().join(',')
        || Object.values(row).some(v => v !== null && typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v) && !Number.isSafeInteger(v))))) throw new Error('SnapshotInvalid');
    });
    if (!verified || verified.sha256 !== part.sha256 || verified.bytes.length !== part.bytes) throw new Error('VerificationFailed');
    yield verified.payload;
  }
}

export async function readExportManifest(bucket, key, service, deep = true) {
  const verified = await verifiedGeneration(bucket, key, p => validateExportManifest(p, service));
  if (!verified) return null;
  const day = exportDay(Date.parse(verified.payload.scheduledFor)), prefix = exportPrefix(service);
  if (key !== `${prefix}daily/${day}.json.gz` && key !== `${prefix}monthly/${day.slice(0,7)}.json.gz`) throw new Error('SnapshotInvalid');
  await assertSchema(service, verified.payload.schema);
  if (deep) for await (const _part of readExportParts(bucket, verified.payload, service)) { /* verifies one bounded part at a time */ }
  return verified;
}

// One fixed D1 export, streamed into bounded, projected parts. Total DB size is
// never accumulated as Worker JSON and live-table paging is never used.
export async function saveExport(env, service, now, { fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), guard = async () => {} } = {}) {
  const spec = exportSpec(service), bucket = exportBucket(env, service), prefix = exportPrefix(service), day = exportDay(now);
  if (!bucket || !env[spec.binding]) throw new Error('SourceUnavailable');
  const daily = `${prefix}daily/${day}.json.gz`, monthly = `${prefix}monthly/${day.slice(0,7)}.json.gz`;
  let saved = await readExportManifest(bucket, daily, service);
  if (!saved) {
    const meta = await schemaMetadata(env[spec.binding], service, spec);
    const createdAt = new Date().toISOString(), run = crypto.randomUUID();
    if (!UUID.test(run)) throw new Error('ExportInvalid');
    const { body, bookmark } = await openExport(env, service, meta.tables, fetcher, sleep);
    const parts = [], ownedKeys = [], tableInfo = Object.fromEntries(spec.tables.map(t => [t.name, { columns: t.columns, rowCount: 0 }]));
    let pending = [], pendingTable = null, pendingBytes = 0, published = false, publishAttempted = false;
    const flush = async () => {
      if (!pending.length) return;
      if (parts.length >= MAX_PARTS) throw new Error('SnapshotTooLarge');
      const key = `${prefix}data/${run}/${String(parts.length).padStart(6,'0')}.json.gz`;
      const bytes = await compress({ table: pendingTable, rows: pending });
      await guard();
      ownedKeys.push(key);
      const sha256 = await verifiedPut(bucket, key, bytes, { format: FORMAT, service }, { etagDoesNotMatch: '*' });
      parts.push({ key, table: pendingTable, rowCount: pending.length, sha256, bytes: bytes.length });
      pending = []; pendingBytes = 0;
    };
    try {
      for await (const sql of sqlStatements(body)) for (const { table, row } of exportedRows(sql, meta.tables)) {
        const size = new TextEncoder().encode(JSON.stringify(row)).length;
        if (size > 8 * 1024 * 1024) throw new Error('SnapshotTooLarge');
        if (pendingTable !== table || pendingBytes + size > PART_BYTES || pending.length >= 1000) await flush();
        pendingTable = table; pending.push(row); pendingBytes += size; tableInfo[table].rowCount++;
      }
      await flush();
      const after = await schemaMetadata(env[spec.binding], service, spec);
      if (JSON.stringify(after) !== JSON.stringify(meta)) throw new Error('SchemaReviewRequired');
      const manifest = { format: FORMAT, service, database: spec.database, expectedMigration: spec.migration, schema: meta.schema,
        scheduledFor: new Date(now).toISOString(), createdAt, completedAt: new Date().toISOString(), consistency: 'single-database-export', bookmark,
        tables: tableInfo, parts, bytes: parts.reduce((n,p) => n+p.bytes,0), rowCount: Object.values(tableInfo).reduce((n,t) => n+t.rowCount,0) };
      validateExportManifest(manifest, service);
      // Read every new part back before publishing a recovery point.
      for await (const _part of readExportParts(bucket, manifest, service)) { /* bounded */ }
      const bytes = await compress(manifest);
      publishAttempted = true;
      await guard();
      await verifiedPut(bucket, daily, bytes, { format: FORMAT, service, backupScope: 'd1-only', dataBytes: String(manifest.bytes) }, { etagDoesNotMatch: '*' });
      saved = await readExportManifest(bucket, daily, service, false);
      if (!saved) throw new Error('VerificationFailed');
      published = saved.payload.parts.some(p => parts.some(own => own.key === p.key));
      // An empty export has no parts, but still has a valid published manifest.
      if (!parts.length) published = true;
    } finally {
      // A failed/ambiguous publish can have committed remotely. Never delete
      // parts it might reference. Such candidates are reported for manual review.
      if (!published && !publishAttempted) for (const key of ownedKeys) await bucket.delete(key).catch(() => {});
    }
  }
  const priorMonthly = await readExportManifest(bucket, monthly, service);
  if (!priorMonthly) {
    await guard();
    await verifiedPut(bucket, monthly, saved.bytes, { format: FORMAT, service, backupScope: 'd1-only', dataBytes: String(saved.payload.bytes) }, { etagDoesNotMatch: '*' });
    if (!await readExportManifest(bucket, monthly, service)) throw new Error('VerificationFailed');
  }
  return { daily, monthly, bytes: saved.payload.bytes, rowCount: saved.payload.rowCount };
}

export async function pruneExports(bucket, service, guard = async () => {}) {
  const prefix = exportPrefix(service), keep = [], obsolete = [];
  for (const [kind, limit] of [['daily',30],['monthly',12]]) {
    const pattern = kind === 'daily' ? /^\d{4}-\d{2}-\d{2}\.json\.gz$/ : /^\d{4}-\d{2}\.json\.gz$/;
    const list = (await listObjects(bucket, prefix + kind + '/')).filter(o => pattern.test(o.key.split('/').at(-1))).sort((a,b) => b.key.localeCompare(a.key));
    keep.push(...list.slice(0,limit)); obsolete.push(...list.slice(limit));
  }
  const referenced = new Set(), removable = new Set();
  // Validate retained manifests and each part's immutable identity/size using
  // HEAD, avoiding 30 full DB downloads every night. Restores use full hashes.
  for (const object of keep) {
    const generation = await readExportManifest(bucket, object.key, service, false);
    if (!generation) throw new Error('VerificationFailed');
    for (const p of generation.payload.parts) {
      if (referenced.has(p.key)) continue;
      referenced.add(p.key);
      const head = await bucket.head(p.key);
      if (!head || head.size !== p.bytes || head.customMetadata?.sha256 !== p.sha256) throw new Error('VerificationFailed');
    }
  }
  for (const object of obsolete) {
    const generation = await readExportManifest(bucket, object.key, service, false);
    if (!generation) throw new Error('VerificationFailed');
    for (const p of generation.payload.parts) if (!referenced.has(p.key)) removable.add(p.key);
  }
  // Remove references before their data. Partial failure only leaves orphans.
  for (const object of obsolete) { await guard(); await bucket.delete(object.key); }
  for (const key of removable) { await guard(); await bucket.delete(key); }
  return obsolete.length;
}
