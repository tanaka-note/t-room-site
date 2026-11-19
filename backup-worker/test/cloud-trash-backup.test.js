import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveSpec } from '../src/registry.js';
import { saveExport, readExportManifest } from '../src/export-backup.js';
import { verifiedPut, compress } from '../src/integrity.js';
import { restoreIsolated } from '../tools/restore-isolated.mjs';
import { database, d1, Bucket } from './fixtures.mjs';
import { exportEnv, exportFetcher } from './export-fixtures.mjs';

const schedule = '2026-11-17T18:40:00.000Z';
const daily = 'd1/cloud/v3/daily/2026-11-18.json.gz';

test('current T-Cloud backup restores trash state and leaves the recovered purge scheduler disabled', async t => {
  const source = database('cloud');
  t.after(() => source.close());
  source.exec(`
    UPDATE cloud_trash_control SET cutover_ready=1, lease_owner='live-run', lease_until=123;
    INSERT INTO cloud_folders(id,name,created_by) VALUES (1,'root','fixture'), (2,'trash','fixture');
    INSERT INTO cloud_trash_operations(id,deleted_at,target_type,target_id) VALUES
      ('file-1','2026-10-17','file',11), ('file-2','2026-10-17','file',12),
      ('folder-2','2026-10-17','folder',2), ('gone-child','2026-10-17','folder',3);
    UPDATE cloud_folders SET deleted_at='2026-10-17',trash_operation_id='folder-2' WHERE id=2;
    INSERT INTO cloud_trash_folder_purges(id,folder_id,parent_id,operation_id,deleted_at,run_id,source)
      VALUES ('folder-purge',3,2,'gone-child','2026-10-17','fixture','manual');
    INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by,deleted_at,trash_operation_id) VALUES
      (11,1,'claimed-object','fixture','application/octet-stream','document',10,'ready','fixture','2026-10-17','file-1'),
      (12,1,'deleted-object','fixture','application/octet-stream','document',10,'ready','fixture','2026-10-17','file-2');
    INSERT INTO cloud_trash_purges(id,file_id,operation_id,deleted_at,folder_id,object_key,size_bytes,source,run_id)
      SELECT 'purge-' || id,id,trash_operation_id,deleted_at,folder_id,object_key,size_bytes,'manual','fixture' FROM cloud_files;
    UPDATE cloud_trash_purges SET phase='objects_deleted' WHERE file_id=12;
    DELETE FROM cloud_files WHERE id=12;
    UPDATE cloud_trash_purges SET phase='completed',completed_at='2026-11-17' WHERE file_id=12;
  `);
  const bucket = new Bucket();
  const { fetcher } = exportFetcher(source, 'cloud');
  const saved = await saveExport(exportEnv('cloud', d1(source), bucket), 'cloud', Date.parse(schedule), { fetcher });
  assert.equal(saved.daily, daily);
  assert.ok(await readExportManifest(bucket, saved.monthly, 'cloud'));

  const { db, payload } = await restoreIsolated(bucket, saved.daily, 'cloud');
  t.after(() => db.close());
  assert.equal(payload.expectedMigration, '0013_safe_trash_retention.sql');
  assert.equal(payload.tables.cloud_trash_control, undefined);
  const control = db.prepare('SELECT cutover_ready,lease_owner,lease_until FROM cloud_trash_control WHERE id=1').get();
  assert.deepEqual({ ...control }, { cutover_ready: 0, lease_owner: null, lease_until: 0 });
  assert.equal(db.prepare('SELECT trash_operation_id FROM cloud_folders WHERE id=2').get().trash_operation_id, 'folder-2');
  assert.equal(db.prepare('SELECT purge_id FROM cloud_files WHERE id=11').get().purge_id, 'purge-11');
  assert.equal(db.prepare("SELECT purge_started FROM cloud_trash_operations WHERE id='file-1'").get().purge_started, 1);
  const deleted = db.prepare('SELECT phase,completed_at FROM cloud_trash_purges WHERE file_id=12').get();
  assert.deepEqual({ ...deleted }, { phase: 'completed', completed_at: '2026-11-17' });
  assert.equal(db.prepare('SELECT id FROM cloud_files WHERE id=12').get(), undefined);
  assert.throws(() => db.exec('UPDATE cloud_files SET deleted_at=NULL WHERE id=11'), /trash_purge_in_progress/);
  assert.throws(() => db.exec('UPDATE cloud_folders SET deleted_at=NULL WHERE id=2'), /trash_purge_in_progress/);
  assert.throws(() => db.exec(`
    INSERT INTO cloud_files(folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by)
      VALUES (1,'deleted-object','fixture','application/octet-stream','document',10,'ready','fixture')
  `), /trash_key_reserved/);
});

test('T-Cloud archives from before the trash migration remain readable in v2 and v3', async t => {
  const migration = '0012_favorites.sql';
  const source = database('cloud', migration);
  t.after(() => source.close());
  source.exec("INSERT INTO cloud_folders(id,name,created_by) VALUES (1,'legacy','fixture')");
  const schema = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const spec = archiveSpec('cloud', migration);
  const tables = Object.fromEntries(spec.tables.map(({ name, columns }) => {
    const rows = source.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all();
    return [name, { columns, rowCount: rows.length, rows }];
  }));
  const bucket = new Bucket();
  const base = { service: 'cloud', database: 'cloud-db', expectedMigration: migration, schema,
    scheduledFor: schedule, createdAt: schedule, completedAt: schedule };
  const legacyKey = 'd1/cloud/v2/daily/2026-11-18.json.gz';
  await verifiedPut(bucket, legacyKey, await compress({ ...base, formatVersion: 2, tables }));
  const key = 'd1/cloud/v3/data/9fbc1e47-9b9e-461a-8cca-d0e900913760/000000.json.gz';
  const part = await compress({ table: 'cloud_folders', rows: tables.cloud_folders.rows });
  const sha256 = await verifiedPut(bucket, key, part);
  const manifest = { ...base, format: 'troom-d1-export-v3', consistency: 'single-database-export',
    bookmark: 'fixture', bytes: part.length, rowCount: 1,
    tables: Object.fromEntries(Object.entries(tables).map(([name, { columns, rowCount }]) => [name, { columns, rowCount }])),
    parts: [{ key, table: 'cloud_folders', bytes: part.length, sha256, rowCount: 1 }] };
  await verifiedPut(bucket, daily, await compress(manifest));
  assert.ok(await readExportManifest(bucket, daily, 'cloud'));

  for (const archive of [legacyKey, daily]) {
    const { db } = await restoreIsolated(bucket, archive, 'cloud');
    try {
      const folder = db.prepare('SELECT name,trash_operation_id FROM cloud_folders WHERE id=1').get();
      assert.deepEqual({ ...folder }, { name: 'legacy', trash_operation_id: null });
      assert.equal(db.prepare('SELECT cutover_ready FROM cloud_trash_control WHERE id=1').get().cutover_ready, 0);
    } finally { db.close(); }
  }
});

