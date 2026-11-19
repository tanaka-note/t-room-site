import {DIARY_ENCRYPTED_MIGRATION,SECURITY_DIARY_MIGRATION,verifyEncryptedDiaryRow} from '../src/diary-encrypted.js';
import {verifyDirectory} from '../../diary-worker/e2ee/crypto.mjs';
import {validateKeyMetadata} from '../../diary-worker/e2ee/backup.mjs';
// Node-only recovery rehearsal. No caller-supplied database/path/SQL, no network
// and no production write API. The returned database is always :memory:.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SERVICES,archiveSpec } from '../src/registry.js';
import { validateSnapshot } from '../src/backup.js';
import { verifiedGeneration } from '../src/integrity.js';
import { BACKUP_TABLES } from '../../diary-worker/src/backup.js';
import { validateExportManifest, readExportParts,exportSpec } from '../src/export-backup.js';
import { assertArchiveSchema } from '../src/schema-guard.js';
import { BILLING_ENCRYPTED_MIGRATION, SECURITY_BILLING_MIGRATION } from '../src/billing-encrypted.js';

// Offline recovery only. This pre-family schema must never be used for live
// capture, and all replay DDL still comes from checked-in migrations.
function recoverySpec(service,migration){
  const spec=archiveSpec(service,migration);
  if(service!=='household'||migration!=='0005_dataset_lifecycle.sql')return spec;
  const tables=spec.tables.filter(t=>!t.name.startsWith('household_crypto_')).map(t=>{
    const columns=t.columns.filter(c=>c!=='household_id'&&c!=='crypto_version');
    return {...t,columns,sourceColumns:columns.join(',')};
  });
  return {...spec,migration,tables};
}
function validateOldHousehold(p){
  const spec=recoverySpec('household',p.expectedMigration);
  if(![1,2].includes(p.formatVersion)||p.service!=='household'||p.database!==spec.database||!Array.isArray(p.schema)||Object.keys(p.tables||{}).sort().join(',')!==spec.tables.map(t=>t.name).sort().join(','))throw new Error('SnapshotInvalid');
  for(const t of spec.tables){const table=p.tables[t.name];if(JSON.stringify(table.columns)!==JSON.stringify(t.columns)||!Array.isArray(table.rows)||table.rowCount!==table.rows.length||table.rows.some(row=>!row||Object.keys(row).sort().join(',')!==[...t.columns].sort().join(',')))throw new Error('SnapshotInvalid');}
}

function diarySnapshotTables(payload) {
  if (![3, 6, 7, 8].includes(payload.formatVersion) || payload.source?.database !== 'diary-db') throw new Error('SnapshotInvalid');
  const omittedEntryColumns = new Set(['last_published_at', 'entry_time', 'weather']);
  const tables = BACKUP_TABLES.map(table => {
    if (table.name === 'diary_entries' && payload.formatVersion === 3) {
      return { ...table, columns: table.columns.filter(column => !omittedEntryColumns.has(column)) };
    }
    if (table.name === 'diary_photos' && ([3, 6].includes(payload.formatVersion)
      || !payload.tables?.diary_photos?.columns?.includes?.('backup_identity'))) {
      return { ...table, columns: table.columns.filter(column => column !== 'backup_identity') };
    }
    return table;
  });
  if (Object.keys(payload.tables ?? {}).sort().join(',') !== tables.map(table => table.name).sort().join(',')) throw new Error('SnapshotInvalid');
  for (const { name, columns } of tables) {
    const table = payload.tables[name];
    const keys = [...columns].sort().join(',');
    if (JSON.stringify(table?.columns) !== JSON.stringify(columns) || !Array.isArray(table.rows)
      || table.rowCount !== table.rows.length || table.rows.some(row => !row || Object.keys(row).sort().join(',') !== keys
        || Object.values(row).some(value => value !== null && typeof value !== 'string'
          && (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))))) {
      throw new Error('SnapshotInvalid');
    }
  }
  return tables;
}

export async function restoreIsolated(bucket, key, service, {anchor,minimumGeneration=1}={}) {
  let tables=service==='diary'?BACKUP_TABLES:SERVICES[service]?.tables;
  if(!tables) throw new Error('UnsupportedService');
  const verified=await verifiedGeneration(bucket,key,p=>{
    if (p?.format === 'troom-d1-export-v3') return validateExportManifest(p,service);
    if(service==='household'&&p?.expectedMigration==='0005_dataset_lifecycle.sql')return validateOldHousehold(p);
    if(service!=='diary') return validateSnapshot(p,service);
    tables=diarySnapshotTables(p);
  });
  if(!verified) throw new Error('GenerationMissing');
  if(service==='household')tables=recoverySpec(service,verified.payload.expectedMigration).tables;
  if(service==='cloud')tables=archiveSpec(service,verified.payload.expectedMigration).tables;
  const exported=verified.payload.format==='troom-d1-export-v3';
  const encryptedDiary=service==='diary'&&verified.payload.expectedMigration===DIARY_ENCRYPTED_MIGRATION;
  const encryptedSecurity=service==='security'&&[SECURITY_DIARY_MIGRATION,SECURITY_BILLING_MIGRATION].includes(verified.payload.expectedMigration);
  const encryptedBilling=service==='billing'&&verified.payload.expectedMigration===BILLING_ENCRYPTED_MIGRATION;
  const billingVaults=service==='security'&&verified.payload.expectedMigration===SECURITY_BILLING_MIGRATION;
  let diaryDirectory;
  if(encryptedDiary){
    if(!anchor)throw new Error('DiaryTrustedAnchorRequired');
    const metadata=verified.payload.keyMetadata;
    diaryDirectory=await verifyDirectory(metadata.directory,anchor,minimumGeneration);
    await validateKeyMetadata(metadata,diaryDirectory,anchor);
  }
  if(encryptedDiary||encryptedSecurity||encryptedBilling)tables=exportSpec(service,verified.payload.expectedMigration).tables;
  if(exported)await assertArchiveSchema(service,verified.payload.expectedMigration,verified.payload.schema);
  const db=new DatabaseSync(':memory:');
  try {
    const dir=new URL(`../../${service}-worker/migrations/`,import.meta.url);
    const migrations=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
    const legacyHousehold=service==='household'&&['0005_dataset_lifecycle.sql','0006_independent_households.sql'].includes(verified.payload.expectedMigration);
    for(const file of migrations.filter(f=>!legacyHousehold||f<=verified.payload.expectedMigration))db.exec(readFileSync(new URL(file,dir),'utf8'));
    if(encryptedDiary)for(const file of ['schema.sql','legacy-fences.sql'])db.exec(readFileSync(new URL('../../diary-worker/e2ee/'+file,import.meta.url),'utf8'));
    if(encryptedSecurity)db.exec(readFileSync(new URL('../../security-worker/e2ee/diary-keys.sql',import.meta.url),'utf8'));
    if(billingVaults)db.exec(readFileSync(new URL('../../security-worker/e2ee/billing-vaults.sql',import.meta.url),'utf8'));
    if(encryptedBilling)db.exec(readFileSync(new URL('../../billing-worker/encryption/migration-preparation.sql',import.meta.url),'utf8'));
    // Triggers are from trusted migrations, never from the archive. Disable
    // replay side effects (inventory stock, immutable audit, etc.) only here.
    const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
    for(const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
    for(const t of [...tables].reverse()) db.exec(`DELETE FROM ${t.name}`);
    if(exported) {
      const inserts=new Map(tables.map(t=>{
        const columns=[...t.columns,...(t.name==='diary_accounts'?['login_id']:[])];
        return [t.name,db.prepare(`INSERT INTO ${t.name} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) RETURNING ${t.columns.join(',')}`)];
      }));
      for await(const part of readExportParts(bucket,verified.payload,service)) {
        const t=tables.find(t=>t.name===part.table);
        for(const row of part.rows) {
          if(encryptedDiary)await verifyEncryptedDiaryRow(part.table,row,diaryDirectory);
          const actual=inserts.get(t.name).get(...t.columns.map(c=>row[c]),...(t.name==='diary_accounts'?[`restored-${row.id}@invalid.local`]:[]));
          if(t.columns.some(c=>actual[c]!==row[c]))throw new Error('RestoreMismatch');
        }
      }
      for(const t of tables)assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t.name}`).get().n,verified.payload.tables[t.name].rowCount);
    } else for(const t of tables) {
      const columns=[...t.columns,...(t.name==='diary_accounts'?['login_id']:[])];
      const insert=db.prepare(`INSERT INTO ${t.name} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      for(const r of verified.payload.tables[t.name].rows) insert.run(...t.columns.map(c=>r[c]),...(t.name==='diary_accounts'?[`restored-${r.id}@invalid.local`]:[]));
    }
    // Check every archived cell before deliberate authorization quarantine.
    const canonical=rows=>rows.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort();
    if (!exported) for (const t of tables) {
      const actual = canonical(db.prepare(`SELECT ${t.columns.join(',')} FROM ${t.name}`).all());
      const expected = canonical(verified.payload.tables[t.name].rows);
      if (service === 'diary') {
        if (actual.length !== expected.length || actual.some((row, index) => row !== expected[index])) throw new Error('RestoreMismatch');
      } else assert.deepEqual(actual, expected, t.name);
    }
    if(service==='security') db.exec("UPDATE security_identities SET status='disabled',is_security_admin=0; UPDATE security_credentials SET status='revoked'; UPDATE security_service_links SET status='disabled'; UPDATE security_invitations SET status='expired'");
    if(['billing','payments','inventory','calendar','portfolio'].includes(service)) db.exec(`UPDATE ${service}_accounts SET is_active=0,session_version=session_version+1`);
    if(service==='diary') db.exec('UPDATE diary_accounts SET active=0,session_version=session_version+1,must_change_password=1');
    if(service==='ai') db.exec("UPDATE ai_accounts SET status='disabled'; UPDATE ai_request_claims SET status='failed',error_code='isolated_restore' WHERE status='processing'");
    if(encryptedDiary)db.exec("UPDATE diary_e2ee_control SET phase='paused',ever_encrypted=1,evidence=json_remove(evidence,'$.photoMigration')");
    // Rebuild only derived Windows state in this new, isolated database. Device
    // grants are excluded from the durable allowlist and never become active.
    if(service==='cloud'&&db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cloud_windows_catalog_control' AND type='table'").get()) {
      db.exec(`DELETE FROM cloud_windows_heads; DELETE FROM cloud_windows_changes;
        UPDATE cloud_windows_catalog_control SET epoch=lower(hex(randomblob(16))),history_floor=0 WHERE id=1;
        INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
          SELECT 'folder',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_folder_projection;
        INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
          SELECT 'file',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_file_projection;
        INSERT INTO cloud_windows_heads(kind,entity_id,seq) SELECT kind,entity_id,seq FROM cloud_windows_changes;`);
    }
    if(service==='security'&&db.prepare("SELECT 1 FROM sqlite_schema WHERE name='security_windows_authority_versions' AND type='table'").get()) {
      db.exec(`DELETE FROM security_windows_authority_versions;
        INSERT INTO security_windows_authority_versions(kind,entity_id,revision) SELECT 'identity',id,1 FROM security_identities;
        INSERT INTO security_windows_authority_versions(kind,entity_id,revision) SELECT 'credential',credential_id,1 FROM security_credentials;
        INSERT INTO security_windows_authority_versions(kind,entity_id,revision) SELECT 'link',id,1 FROM security_service_links;`);
    }
    for(const t of triggers) db.exec(t.sql);
    if(legacyHousehold)for(const file of migrations.filter(f=>f>verified.payload.expectedMigration))db.exec(readFileSync(new URL(file,dir),'utf8'));
    // 0006 creates an additional Household account. Quarantine after all
    // upgrades so that newly introduced accounts are disabled as well.
    if(service==='household')db.exec('UPDATE household_accounts SET is_active=0,session_version=session_version+1');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.exec('COMMIT');
    // Existing photo resolver consumes the v8 reference envelope. Build it from
    // the restored, hash-verified rows; never infer identities from live R2.
    const photoPayload=service==='diary'&&exported&&!encryptedDiary?{formatVersion:8,backupScope:'d1-only',tables:{diary_photos:{rows:db.prepare(`SELECT ${BACKUP_TABLES.find(t=>t.name==='diary_photos').columns.join(',')} FROM diary_photos`).all().map(r=>({...r}))}}}:null;
    return { db, payload: verified.payload, sha256: verified.sha256, ...(photoPayload?{photoPayload}:{}),...(encryptedDiary?{encryptedDiary:{directory:diaryDirectory,keyMetadata:verified.payload.keyMetadata}}:{}) };
  } catch(error) { db.close(); throw error; }
}

export function diaryRestoreReport(restored) {
  if(!restored.encryptedDiary)throw new Error('EncryptedDiaryRestoreRequired');
  const records=restored.db.prepare('SELECT * FROM diary_e2ee_records ORDER BY id').all().map(row=>({
    id:row.id,household:row.household,scope:row.scope,state:row.state,author:row.author,revision:row.revision,epoch:row.epoch,
    sourceId:row.source_id,sourceRevision:row.source_revision,retainedFor:JSON.parse(row.retained_for),envelope:JSON.parse(row.envelope),summary:JSON.parse(row.summary),photoIds:JSON.parse(row.photo_ids),keyBox:JSON.parse(row.key_box),attestation:JSON.parse(row.attestation)}));
  return {protocol:'T-lain diary isolated restore',version:1,archiveSha256:restored.sha256,directoryGeneration:restored.encryptedDiary.directory.generation,
    sequence:restored.db.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes').get().sequence,
    records,media:restored.db.prepare('SELECT * FROM diary_e2ee_media ORDER BY id').all().map(row=>({...row}))};
}
