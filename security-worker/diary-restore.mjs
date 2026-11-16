import initSqlJs from 'sql.js';
import trustedDDL from 'diary-trusted-ddl';
import {verifiedGeneration} from '../backup-worker/src/integrity.js';
import {validateExportManifest,readExportParts,exportSpec} from '../backup-worker/src/export-backup.js';
import {assertArchiveSchema} from '../backup-worker/src/schema-guard.js';
import {verifyEncryptedDiaryRow} from '../backup-worker/src/diary-encrypted.js';
import {validateKeyMetadata} from '../diary-worker/e2ee/backup.mjs';
import {verifyDirectory,encode} from '../diary-worker/e2ee/crypto.mjs';
import {parseRecord} from '../diary-worker/e2ee/store.mjs';

const rows=(db,sql)=>{const statement=db.prepare(sql),result=[];try{while(statement.step())result.push(statement.getAsObject());return result;}finally{statement.free();}};

// Restore the real checkpoint into a NEW in-memory SQLite database on the
// trusted device. Archive SQL is never executed; DDL is bundled from Git.
export async function restoreDiaryCheckpoint({bucket,key,trust,onProgress=()=>{}}) {
  const verified=await verifiedGeneration(bucket,key,p=>validateExportManifest(p,'diary'));
  if(!verified||verified.payload.expectedMigration!=='diary-e2ee-v1')throw new Error('EncryptedCheckpointRequired');
  const manifest=verified.payload;
  await assertArchiveSchema('diary',manifest.expectedMigration,manifest.schema);
  const directory=await verifyDirectory(manifest.keyMetadata.directory,trust.anchor,trust.minimumGeneration);
  await validateKeyMetadata(manifest.keyMetadata,directory,trust.anchor);
  const SQL=await initSqlJs({locateFile:()=>'/security/vendor/sql-wasm.wasm'}),db=new SQL.Database();
  try {
    db.exec(trustedDDL);
    const triggers=rows(db,"SELECT name,sql FROM sqlite_schema WHERE type='trigger'");
    const tables=exportSpec('diary','diary-e2ee-v1').tables;
    db.exec('BEGIN; PRAGMA defer_foreign_keys=ON;');
    for(const trigger of triggers)db.exec(`DROP TRIGGER "${trigger.name}"`);
    for(const table of [...tables].reverse())db.exec(`DELETE FROM ${table.name}`);
    const counts=new Map();let total=0,bytes=0;
    for await(const part of readExportParts(bucket,manifest,'diary')) {
      const table=tables.find(table=>table.name===part.table),columns=[...table.columns,...(table.name==='diary_accounts'?['login_id']:[])];
      const insert=db.prepare(`INSERT INTO ${table.name} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) RETURNING ${table.columns.join(',')}`);
      try{for(const row of part.rows) {
        await verifyEncryptedDiaryRow(part.table,row,directory);
        bytes+=encode(row).length;if(bytes>100_000_000)throw new Error('RestoreBudgetExceeded');
        insert.bind([...table.columns.map(column=>row[column]),...(table.name==='diary_accounts'?[`restored-${row.id}@invalid.local`]:[])]);
        if(!insert.step())throw new Error('RestoreMismatch');
        const actual=insert.getAsObject();if(table.columns.some(column=>actual[column]!==row[column]))throw new Error('RestoreMismatch');
        insert.reset();
        counts.set(table.name,(counts.get(table.name)||0)+1);total++;
      }}finally{insert.free();}
      onProgress({phase:'restoring',completed:total});
    }
    for(const table of tables)if((counts.get(table.name)||0)!==manifest.tables[table.name].rowCount||rows(db,`SELECT count(*) n FROM ${table.name}`)[0].n!==manifest.tables[table.name].rowCount)throw new Error('RestoreRowCountMismatch');
    db.exec("UPDATE diary_accounts SET active=0,session_version=session_version+1,must_change_password=1; UPDATE diary_e2ee_control SET phase='paused',ever_encrypted=1;");
    for(const trigger of triggers)db.exec(trigger.sql);
    if(rows(db,'PRAGMA integrity_check')[0].integrity_check!=='ok'||rows(db,'PRAGMA foreign_key_check').length)throw new Error('RestoreIntegrityFailed');
    db.exec('COMMIT');
    return {protocol:'T-lain diary isolated restore',version:1,archiveSha256:verified.sha256,directoryGeneration:directory.generation,
      sequence:rows(db,'SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes')[0].sequence,
      records:rows(db,'SELECT * FROM diary_e2ee_records ORDER BY id').map(parseRecord),media:rows(db,'SELECT * FROM diary_e2ee_media ORDER BY id')};
  }finally{db.close();}
}
