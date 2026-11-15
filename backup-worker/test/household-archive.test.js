import test from 'node:test';
import assert from 'node:assert/strict';
import {Bucket,recorder,d1,database} from './fixtures.mjs';
import {backupService} from '../src/backup.js';
import {sealHouseholdArchive,openHouseholdArchive,rehearseHouseholdArchive,archiveRecipientFingerprint,householdHistoryStatus} from '../tools/household-archive.mjs';
import {observeHouseholdHistory} from '../tools/check-household-history.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {compress,verifiedPut} from '../src/integrity.js';
import {restoreIsolated} from '../tools/restore-isolated.mjs';
async function fixture(){
 const db=database('household'),bucket=new Bucket();
 try{
  assert.equal((await backupService({HOUSEHOLD_DB:d1(db),BACKUP:bucket,...recorder()},'household',Date.parse('2026-11-12T00:00:00Z'),async()=>{})).state,'ok');
  const objects=[...bucket.objects].filter(([key])=>key.startsWith('d1/household/')).map(([key,value])=>({bucket:'t-room-service-backups',key,bytes:value.bytes,metadata:value.customMetadata,etag:value.etag,uploadedAt:value.uploaded.toISOString()}));
  const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  return {objects,pair,publicKey:await crypto.subtle.exportKey('jwk',pair.publicKey)};
 }finally{db.close();}
}
test('public-key-only sealing preserves original objects and metadata; recipient key opens every generation for isolated recovery',async()=>{
 const f=await fixture(),before=f.objects.map(x=>({key:x.key,bytes:Buffer.from(x.bytes).toString('base64'),metadata:x.metadata}));
 const {archive,summary}=await sealHouseholdArchive(f.objects,f.publicKey);
 assert.equal(summary.contentRoundTripVerified,true);assert.equal(summary.recipientPrivateKeyVerified,false);
 assert.equal(archive.recipientFingerprint,await archiveRecipientFingerprint(f.publicKey));
 assert.deepEqual(Object.keys(archive).sort(),['algorithm','ciphertext','createdAt','format','id','iv','recipientFingerprint','version','wrappedKey']);
 const opened=await openHouseholdArchive(archive,f.pair.privateKey);
 assert.deepEqual(opened.map(x=>({key:x.key,bytes:Buffer.from(x.bytes).toString('base64'),metadata:x.metadata})),before);
 assert.deepEqual(f.objects.map(x=>({key:x.key,bytes:Buffer.from(x.bytes).toString('base64'),metadata:x.metadata})),before);
 const restored=await rehearseHouseholdArchive(opened);assert.equal(restored.generations,2);assert.equal(restored.isolatedRestoreVerified,true);
 const another=await sealHouseholdArchive(f.objects,f.publicKey);assert.notEqual(another.archive.iv,archive.iv);assert.notEqual(another.archive.ciphertext,archive.ciphertext);
});
test('wrong recipient, metadata and ciphertext changes fail authenticated recovery; corrupt or out-of-scope sources cannot be archived',async()=>{
 const f=await fixture(),{archive}=await sealHouseholdArchive(f.objects,f.publicKey),other=await fixture();
 await assert.rejects(openHouseholdArchive(archive,other.pair.privateKey));
 for(const change of [{id:crypto.randomUUID()},{recipientFingerprint:'0'.repeat(64)},{createdAt:'2026-01-01T00:00:00Z'},{ciphertext:(archive.ciphertext[0]==='A'?'B':'A')+archive.ciphertext.slice(1)},{wrappedKey:(archive.wrappedKey[0]==='A'?'B':'A')+archive.wrappedKey.slice(1)},{iv:'A'.repeat(16)}])await assert.rejects(openHouseholdArchive({...archive,...change},f.pair.privateKey));
 await assert.rejects(sealHouseholdArchive([{...f.objects[0],key:'d1/diary/v2/daily/2026-11-12.json.gz'}],f.publicKey));
 await assert.rejects(sealHouseholdArchive([...f.objects,f.objects[0]],f.publicKey));
 await assert.rejects(sealHouseholdArchive([{...f.objects[0],bytes:new Uint8Array([1,2,3])}],f.publicKey));
 await assert.rejects(sealHouseholdArchive(f.objects,{...f.publicKey,d:'private-material-is-not-accepted'}));
});
test('Time Travel cannot be declared complete while any current plaintext remains or without a verified cutover time',()=>{
 const observedAt='2026-12-20T00:00:00Z',lastPlaintextRemovedAt='2026-11-12T00:00:00Z';
 const encrypted={crypto_version:1,generations:2},plain={crypto_version:0,generations:1};
 assert.equal(householdHistoryStatus([encrypted,plain],{observedAt,lastPlaintextRemovedAt}).state,'blocked_by_current_plaintext');
 assert.equal(householdHistoryStatus([encrypted],{observedAt}).state,'requires_verified_cutover_time');
 assert.equal(householdHistoryStatus([encrypted],{observedAt:'2026-11-20T00:00:00Z',lastPlaintextRemovedAt}).state,'waiting_for_retention');
 assert.equal(householdHistoryStatus([encrypted],{observedAt,lastPlaintextRemovedAt}).state,'retention_window_elapsed');
 assert.throws(()=>householdHistoryStatus([{crypto_version:9,generations:1}],{observedAt}));
});
test('history observations start conservatively, retain the cutover and reset it if plaintext reappears or the database changes',()=>{
 const encrypted=[{crypto_version:1,generations:3}],plain=[...encrypted,{crypto_version:0,generations:1}],databaseId='fixture';
 const start=observeHouseholdHistory(encrypted,null,{databaseId,observedAt:'2026-11-12T00:00:00Z'});
 assert.equal(start.state,'waiting_for_retention');assert.equal(start.earliestCompletionAt,'2026-12-12T00:00:00.000Z');
 const ready=observeHouseholdHistory(encrypted,start,{databaseId,observedAt:'2026-12-13T00:00:00Z'});assert.equal(ready.state,'retention_window_elapsed');
 const reset=observeHouseholdHistory(plain,ready,{databaseId,observedAt:'2026-12-14T00:00:00Z'});assert.equal(reset.firstObservedFullyEncryptedAt,null);assert.equal(reset.earliestCompletionAt,null);
 const migrated=observeHouseholdHistory(encrypted,reset,{databaseId,observedAt:'2026-12-15T00:00:00Z'});assert.equal(migrated.earliestCompletionAt,'2027-01-14T00:00:00.000Z');
 const changed=observeHouseholdHistory(encrypted,start,{databaseId:'another-database',observedAt:'2026-12-15T00:00:00Z'});assert.equal(changed.earliestCompletionAt,migrated.earliestCompletionAt);
});
test('0005 plaintext generations restore all original cells, upgrade using trusted migrations and disable newly introduced accounts',async()=>{
 const db=new DatabaseSync(':memory:'),bucket=new Bucket();let restored;
 try{
  const directory=new URL('../../household-worker/migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')&&n<='0005_dataset_lifecycle.sql').sort())db.exec(readFileSync(new URL(name,directory),'utf8'));
  const names=['household_accounts','household_state','household_records','household_requests','household_datasets'];
  const tables=Object.fromEntries(names.map(name=>{const rows=db.prepare(`SELECT * FROM ${name}`).all();return [name,{columns:db.prepare(`PRAGMA table_info(${name})`).all().map(c=>c.name),rowCount:rows.length,rows}];}));
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const snapshot={formatVersion:2,service:'household',database:'household-db',expectedMigration:'0005_dataset_lifecycle.sql',schema,tables};
  const key='d1/household/v2/daily/2026-10-31.json.gz';await verifiedPut(bucket,key,await compress(snapshot));
  restored=await restoreIsolated(bucket,key,'household');
  assert.deepEqual(restored.db.prepare("SELECT * FROM household_records WHERE dataset_id='initial' ORDER BY kind,id").all(),db.prepare("SELECT * FROM household_records WHERE dataset_id='initial' ORDER BY kind,id").all());
  const accounts=restored.db.prepare('SELECT id,is_active,session_version FROM household_accounts ORDER BY id').all();assert.equal(accounts.length,3);assert.ok(accounts.every(a=>a.is_active===0&&a.session_version===2));
  assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,0);
  assert.ok(restored.db.prepare('SELECT crypto_version FROM household_datasets').all().every(d=>d.crypto_version===0));
  const objects=[...bucket.objects].map(([key,value])=>({bucket:'t-room-service-backups',key,bytes:value.bytes,metadata:value.customMetadata,etag:value.etag,uploadedAt:value.uploaded.toISOString()}));
  assert.equal((await rehearseHouseholdArchive(objects)).generations,1);
  const malformed=structuredClone(snapshot);malformed.tables.household_accounts.columns.push('unreviewed');await verifiedPut(bucket,key,await compress(malformed));
  await assert.rejects(restoreIsolated(bucket,key,'household'),/SnapshotInvalid/);
 }finally{restored?.db.close();db.close();}
});
