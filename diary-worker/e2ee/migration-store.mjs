import {investmentBinding} from './investment.mjs';
import {b64,encode,validateEnvelope} from './crypto.mjs';
import {bindingOf,verifyRecord} from './record.mjs';
import {parseRecord} from './store.mjs';
import {readRollout} from './rollout.mjs';
import {LEGACY_TABLES,legacyEntryBinding,legacyPreferenceBinding} from './migration.mjs';
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const equal=(a,b)=>b64(encode(a))===b64(encode(b));
const hash=async value=>b64(await crypto.subtle.digest('SHA-256',encode(value)));
const MEDIA_COLUMNS=['id','household','account_id','session_id','status','original_key','display_key','thumbnail_key','metadata','epoch','request_hash','expires_at','retired_at'];
// Read pages have a row AND byte bound; writes remain capped at 20 rows.
export function boundedInventoryPage(rows) {
  const page=[];let bytes=2;
  for(const row of rows) {
    const next=bytes+encode(row).length+(page.length?1:0);
    if(next>1_790_000){if(!page.length)fail('MaintenanceRecordBudgetExceeded');break;}
    page.push(row);bytes=next;
  }
  return page;
}
export async function requireFrozenMigration(db) {
  const control=await readRollout(db);
  if(control.phase!=='migrating'||control.everEncrypted)fail('MigrationRequiresFrozenLegacyDatabase');
  const expected=LEGACY_TABLES.flatMap(table=>['insert','update','delete'].map(action=>`diary_plaintext_${{diary_entries:'entry',diary_tags:'tag',diary_photos:'photo',diary_trash_scopes:'scope',diary_favorites:'favorite',investment_history:'investment'}[table]}_${action}`));
  const count=await db.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE type='trigger' AND name IN (SELECT value FROM json_each(?))").bind(JSON.stringify(expected)).first();
  if(count.count!==expected.length)fail('LegacyWriteFencesRequired');
  const active=await db.prepare("SELECT COUNT(*) count FROM diary_photo_upload_sessions WHERE status='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')").first();
  if(active.count)fail('UnfinishedLegacyUploads');
  return control;
}
export async function migrationInventory(db,{table,after=0,limit=20}={}) {
  const control=await requireFrozenMigration(db);
  if(!LEGACY_TABLES.includes(table)||!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)fail('InvalidMigrationPage');
  const result=(await db.prepare(`SELECT rowid _cursor,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).bind(after,limit+1).all()).results;
  const page=boundedInventoryPage(result.slice(0,limit));
  return {controlGeneration:control.generation,rows:page.map(({_cursor,...row})=>row),nextCursor:result.length>page.length?page.at(-1)._cursor:null};
}
async function sourceBinding(db,row,directory) {
  if(row.state==='investment') {
    if(!(await db.prepare('SELECT 1 found FROM investment_history LIMIT 1').first()))fail('UnexpectedMigrationInvestment');
    return investmentBinding(directory);
  }
  if(row.state==='preferences') {
    const exists=await db.prepare('SELECT 1 found FROM diary_favorites f JOIN diary_entries e ON e.id=f.entry_id WHERE f.account_id=? AND e.household_id=? LIMIT 1').bind(row.author,row.household).first();
    if(!exists)fail('UnexpectedMigrationPreference');
    return legacyPreferenceBinding(row.household,row.author,directory.epochs);
  }
  const source=await db.prepare('SELECT * FROM diary_entries WHERE id=?').bind(Number(row.id)).first();
  if(!source)fail('MigrationSourceMissing');
  const [photos,scopes]=await db.batch([
    db.prepare('SELECT * FROM diary_photos WHERE entry_id=? OR entry_id=?').bind(source.id,source.draft_of_entry_id||source.id),
    db.prepare('SELECT * FROM diary_trash_scopes WHERE entry_id=?').bind(source.id),
  ]);
  return legacyEntryBinding(source,{photos:photos.results,scopes:scopes.results},directory.epochs);
}
export async function importMigration(db,{kind,rows,directory,expectedGeneration}) {
  const control=await requireFrozenMigration(db);
  if(control.generation!==expectedGeneration)fail('MigrationCheckpointChanged');
  if(!['records','media'].includes(kind)||!Array.isArray(rows)||!rows.length||rows.length>20||encode(rows).length>2_000_000)fail('InvalidMigrationBatch');
  const statements=[];
  for(const row of rows) {
    if(kind==='records') {
      await verifyRecord(row,directory);
      const expected=await sourceBinding(db,row,directory);
      if(!equal(bindingOf(row),expected)||row.attestation.recovery?.operation!=='migration'||row.attestation.recovery.previousDigest!==await hash(expected))fail('MigrationSourceMismatch');
      statements.push(db.prepare(`INSERT INTO diary_e2ee_records(id,household,scope,state,author,revision,epoch,source_id,source_revision,retained_for,envelope,summary,photo_ids,request_id,mutation_id,key_box,attestation) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT generation FROM diary_e2ee_control WHERE id=1)=? ON CONFLICT(id) DO NOTHING`)
        .bind(row.id,row.household,row.scope,row.state,row.author,row.revision,row.epoch,row.sourceId,row.sourceRevision,JSON.stringify(row.retainedFor),JSON.stringify(row.envelope),JSON.stringify(row.summary),JSON.stringify(row.photoIds),'migration:'+row.id,'migration:'+row.id,JSON.stringify(row.keyBox),JSON.stringify(row.attestation),control.generation));
    }else {
      if(Object.keys(row).sort().join(',')!==[...MEDIA_COLUMNS].sort().join(','))fail('InvalidMigrationMedia');
      const source=await db.prepare('SELECT p.*,e.household_id FROM diary_photos p JOIN diary_entries e ON e.id=p.entry_id WHERE p.id=?').bind(row.id).first();
      if(!source||row.household!==source.household_id||row.account_id!==source.created_by_id||row.session_id!==source.id||row.status!=='attached'||row.retired_at!==null||row.expires_at!==0||row.epoch!==directory.epochs[`${source.household_id}:preferences:${source.created_by_id}`]||
        ['original_key','display_key','thumbnail_key'].some(key=>row[key]!==source[key]))fail('MigrationMediaSourceMismatch');
      validateEnvelope(JSON.parse(row.metadata));
      if(row.request_hash!==await hash({id:row.id,metadata:row.metadata}))fail('MigrationMediaSourceMismatch');
      statements.push(db.prepare(`INSERT INTO diary_e2ee_media(${MEDIA_COLUMNS.join(',')}) SELECT ${MEDIA_COLUMNS.map(()=>'?').join(',')} WHERE (SELECT generation FROM diary_e2ee_control WHERE id=1)=? ON CONFLICT(id) DO NOTHING`).bind(...MEDIA_COLUMNS.map(key=>row[key]),control.generation));
    }
    const existing=await db.prepare(`SELECT * FROM diary_e2ee_${kind} WHERE id=?`).bind(row.id).first();
    if(existing&&!equal(kind==='records'?parseRecord(existing):existing,row))fail('MigrationRetryConflict');
  }
  await db.batch(statements);
  // A lost response is safe to retry only with the exact ciphertext. The trusted
  // device persists this encrypted plan, never the plaintext source or keys.
  for(const row of rows) {
    const saved=await db.prepare(`SELECT * FROM diary_e2ee_${kind} WHERE id=?`).bind(row.id).first();
    if(!saved||!equal(kind==='records'?parseRecord(saved):saved,row))fail('MigrationCheckpointChanged');
  }
  return {imported:rows.length,controlGeneration:control.generation};
}
export async function verifyLegacyCoverage(db) {
  const checks=[
    "SELECT CASE WHEN (SELECT COUNT(*) FROM diary_e2ee_records WHERE state='investment')!=CASE WHEN EXISTS(SELECT 1 FROM investment_history) THEN 1 ELSE 0 END THEN 1 ELSE 0 END count",
    "SELECT COUNT(*) count FROM diary_entries e LEFT JOIN diary_e2ee_records r ON r.id=CAST(e.id AS TEXT) WHERE r.id IS NULL OR r.household!=e.household_id OR r.revision!=e.revision OR r.author!=e.author_id",
    "SELECT COUNT(*) count FROM diary_e2ee_records r LEFT JOIN diary_entries e ON r.id=CAST(e.id AS TEXT) WHERE r.state NOT IN ('preferences','investment') AND e.id IS NULL",
    "SELECT COUNT(*) count FROM diary_favorites f JOIN diary_entries e ON e.id=f.entry_id LEFT JOIN diary_e2ee_records r ON r.id=e.household_id||':preferences:'||f.account_id WHERE r.id IS NULL",
    "SELECT COUNT(*) count FROM diary_photos p LEFT JOIN diary_e2ee_media m ON m.id=p.id WHERE m.id IS NULL OR p.original_key!=m.original_key OR p.display_key!=m.display_key OR p.thumbnail_key!=m.thumbnail_key",
    "SELECT COUNT(*) count FROM diary_e2ee_media m LEFT JOIN diary_photos p ON m.id=p.id WHERE p.id IS NULL",
  ];
  const result=await db.batch(checks.map(sql=>db.prepare(sql)));
  if(result.some(row=>row.results[0].count))fail('IncompleteLegacyMigration');
}
