import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {Bucket,recorder,d1,database} from './fixtures.mjs';
import {backupService} from '../src/backup.js';
import {restoreIsolated} from '../tools/restore-isolated.mjs';
import {compress,verifiedPut} from '../src/integrity.js';
import {archiveSpec} from '../src/registry.js';
import {decryptRow,encryptRow,createClientVault,wrapMaster,unwrapMaster,recordKeys,keyScope} from '../../household-worker/public/household-crypto.mjs';

import {manageKeys} from '../../household-worker/src/keys.js';
import {dataFromRecords,mutateData,records} from '../../household-worker/src/domain.js';
import {saveExport} from '../src/export-backup.js';
import {exportEnv,exportFetcher} from './export-fixtures.mjs';

test('scheduled backup keeps ciphertext and matching recovery envelopes together; isolated restore actually decrypts records without reactivating accounts',async()=>{
  const sqlite=database('household'),bucket=new Bucket(),audit=recorder();let restored;
  const master=crypto.getRandomValues(new Uint8Array(32)),prf=crypto.getRandomValues(new Uint8Array(32));
  try{
    const configInput={householdId:'main',keyId:crypto.randomUUID()},DB=d1(sqlite);
    const recovery=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
    const pub=await crypto.subtle.exportKey('jwk',recovery.publicKey),vault=await createClientVault(prf);
    await manageKeys(DB,'vault',{identityId:'primary-admin',credentialId:'fixture-credential',vault});
    await manageKeys(DB,'initialize',{serviceAccountId:'owner',...configInput,recoveryPublicKey:pub,recoveryWrappedKey:await wrapMaster(master,pub,keyScope(configInput))});
    await manageKeys(DB,'grant',{serviceAccountId:'owner',identityId:'primary-admin',credentialId:'fixture-credential',serviceLinkId:'fixture-link',keyId:configInput.keyId,wrappedKey:await wrapMaster(master,vault.publicKey,keyScope(configInput))});
    const original=dataFromRecords(sqlite.prepare("SELECT kind,id,payload FROM household_records WHERE dataset_id='initial'").all());
    const plain=mutateData(original,'transaction.save',{id:crypto.randomUUID(),type:'expense',date:'2026-11-01',amount:12345,categoryId:original.categories.find(c=>c.type==='expense').id,description:'synthetic-private-ledger-content',notes:'synthetic-private-notes'});
    const encryptionKeys=await recordKeys(master);
    sqlite.exec("DELETE FROM household_records WHERE dataset_id='initial'; UPDATE household_datasets SET crypto_version=1 WHERE id='initial'");
    for(const r of records(plain)){const row=await encryptRow(encryptionKeys,configInput,r.kind,JSON.parse(r.payload));sqlite.prepare("INSERT INTO household_records VALUES('initial',?,?,?)").run(row.kind,row.id,JSON.stringify(row.payload));}
    const config=sqlite.prepare('SELECT * FROM household_crypto_config').all();
    const env={HOUSEHOLD_DB:d1(sqlite),BACKUP:bucket,...audit};
    assert.equal((await backupService(env,'household',Date.parse('2026-11-12T00:00:00Z'),async()=>{})).state,'ok');
    restored=await restoreIsolated(bucket,'d1/household/v2/daily/2026-11-12.json.gz','household');
    assert.deepEqual(restored.db.prepare('SELECT * FROM household_crypto_config').all(),config);
    assert.ok(restored.db.prepare('SELECT * FROM household_accounts').all().every(a=>a.is_active===0&&a.session_version===2));
    const saved=config[0],scope={householdId:saved.household_id,keyId:saved.key_id};
    const recoveredMaster=await unwrapMaster(recovery.privateKey,saved.recovery_wrapped_key,keyScope(scope)),keys=await recordKeys(recoveredMaster);recoveredMaster.fill(0);
    const dataset=restored.db.prepare("SELECT active_dataset FROM household_state WHERE id='main'").get().active_dataset;
    const rows=restored.db.prepare('SELECT kind,id,payload FROM household_records WHERE dataset_id=?').all(dataset);
    const values=await Promise.all(rows.map(row=>decryptRow(keys,scope,{...row,payload:JSON.parse(row.payload)})));
    assert.deepEqual(values.find(v=>v.id===plain.transactions[0].id),plain.transactions[0]);
    assert.doesNotMatch(JSON.stringify(restored.payload),/synthetic-private|synthetic-private-notes/);
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM household_crypto_grants').get().n,1);
    const exported=await saveExport(exportEnv('household',d1(sqlite),bucket),'household',Date.parse('2026-11-12T00:00:00Z'),{fetcher:exportFetcher(sqlite,'household').fetcher,sleep:async()=>{}});
    assert.equal(exported.daily,'d1/household/v3/daily/2026-11-12.json.gz');
    const streamed=await restoreIsolated(bucket,'d1/household/v3/daily/2026-11-12.json.gz','household');
    try{
      assert.equal(streamed.payload.expectedMigration,'0007_client_encryption.sql');
      assert.deepEqual(streamed.db.prepare('SELECT * FROM household_crypto_config').all(),config);
      const row=streamed.db.prepare("SELECT kind,id,payload FROM household_records WHERE dataset_id=? AND kind='transactions'").get(dataset);
      assert.deepEqual(await decryptRow(keys,scope,{...row,payload:JSON.parse(row.payload)}),plain.transactions[0]);
    }finally{streamed.db.close();}
  }finally{restored?.db.close();master.fill(0);prf.fill(0);sqlite.close();}
});

test('previous plaintext database backups remain restorable under their exact old schema, then receive empty encryption tables and disabled accounts',async()=>{
  const db=new DatabaseSync(':memory:'),bucket=new Bucket();let restored;
  try{
    const dir=new URL('../../household-worker/migrations/',import.meta.url);
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')&&f<='0006_independent_households.sql').sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
    const spec=archiveSpec('household','0006_independent_households.sql');
    const tables=Object.fromEntries(spec.tables.map(t=>{const rows=db.prepare(`SELECT ${t.columns.join(',')} FROM ${t.name}`).all();return[t.name,{columns:t.columns,rowCount:rows.length,rows}];}));
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
    const value={formatVersion:2,service:'household',database:spec.database,expectedMigration:spec.migration,schema,tables};
    const key='d1/household/v2/daily/2026-11-01.json.gz';await verifiedPut(bucket,key,await compress(value));
    restored=await restoreIsolated(bucket,key,'household');
    assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,0);
    assert.ok(restored.db.prepare('SELECT crypto_version FROM household_datasets').all().every(d=>d.crypto_version===0));
    assert.deepEqual(restored.db.prepare('SELECT * FROM household_records ORDER BY dataset_id,kind,id').all(),db.prepare('SELECT * FROM household_records ORDER BY dataset_id,kind,id').all());
    const parts=[],tableInfo={},exportId=crypto.randomUUID();
    for(const [name,table] of Object.entries(tables)){
      tableInfo[name]={columns:table.columns,rowCount:table.rowCount};
      if(!table.rows.length)continue;
      const bytes=await compress({table:name,rows:table.rows}),partKey=`d1/household/v3/data/${exportId}/${String(parts.length).padStart(6,'0')}.json.gz`;
      const sha256=await verifiedPut(bucket,partKey,bytes);
      parts.push({key:partKey,table:name,rowCount:table.rowCount,bytes:bytes.length,sha256});
    }
    const stamp='2026-11-01T00:00:00Z',manifest={format:'troom-d1-export-v3',service:'household',database:spec.database,expectedMigration:spec.migration,
      consistency:'single-database-export',scheduledFor:stamp,createdAt:stamp,completedAt:stamp,bookmark:'synthetic-old-export',schema,parts,tables:tableInfo,
      bytes:parts.reduce((n,p)=>n+p.bytes,0),rowCount:parts.reduce((n,p)=>n+p.rowCount,0)};
    const exportKey='d1/household/v3/daily/2026-11-01.json.gz';await verifiedPut(bucket,exportKey,await compress(manifest));
    const streamed=await restoreIsolated(bucket,exportKey,'household');
    try{assert.deepEqual(streamed.db.prepare('SELECT * FROM household_records ORDER BY dataset_id,kind,id').all(),db.prepare('SELECT * FROM household_records ORDER BY dataset_id,kind,id').all());assert.equal(streamed.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,0);}
    finally{streamed.db.close();}
  }finally{restored?.db.close();db.close();}
});
