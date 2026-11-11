import assert from 'node:assert/strict';
import { before,test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fixture,provision,entry } from './fixture.mjs';
import { memoryDatabase } from './sqlite.mjs';
import { readRollout,transitionRollout,rollbackPlan } from '../../e2ee/rollout.mjs';
import { signed } from '../../e2ee/crypto.mjs';
let prepared;
before(async()=>{prepared=await provision();});
const operator=f=>({...f.actors.ownerA,reauthenticatedAt:Date.now()/1000});
async function proof(f,client) {
  return signed({protocol:'T-lain diary cutover',version:1,records:f.db.sqlite.prepare('SELECT COUNT(*) records FROM diary_e2ee_records').get().records,sequence:f.db.sqlite.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes').get().sequence,directoryGeneration:1,sourceManifestDigest:'a'.repeat(43),restoreDigest:'b'.repeat(43),readerBuild:'reader-1',writerBuild:'writer-1',formats:[1,2]},client.privateKeys.sign);
}
test('default schema is legacy and encrypted writes fail closed before cutover',async()=>{
  const db=memoryDatabase({phase:'legacy'});try {
    assert.equal((await readRollout(db)).phase,'legacy');
    assert.throws(()=>db.sqlite.prepare("INSERT INTO diary_e2ee_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('1','A','A:published','published','ownerA',1,1,null,null,'[]','{}','{}','[]','request','request','{}','{}'),/DiaryWritesPaused/);
  }finally{db.close();}
});
test('only recently authenticated global owner can change modes; generation prevents lost updates',async()=>{
  const f=await fixture(prepared);try {
    f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='legacy'");
    await assert.rejects(transitionRollout(f.db,{actor:{...operator(f),isGlobalOwner:false},expectedGeneration:0,next:'migrating'}),/AccessDenied/);
    await assert.rejects(transitionRollout(f.db,{actor:{...operator(f),reauthenticatedAt:0},expectedGeneration:0,next:'migrating'}),/RecentAuthenticationRequired/);
    const result=await transitionRollout(f.db,{actor:operator(f),expectedGeneration:0,next:'migrating'});assert.equal(result.generation,1);
    await assert.rejects(transitionRollout(f.db,{actor:operator(f),expectedGeneration:0,next:'legacy'}),/RolloutConflict/);
    assert.equal((await transitionRollout(f.db,{actor:operator(f),expectedGeneration:1,next:'legacy'})).phase,'legacy');
  }finally{f.close();}
});
test('cutover requires signed restore/source evidence pinned to current count and sequence',async()=>{
  const f=await fixture(prepared);try {
    const client=await f.client('ownerA');await client.saveEntry(entry());
    f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='migrating'");
    const evidence=await proof(f,client),args={actor:operator(f),expectedGeneration:0,next:'encrypted',directory:prepared.directory};
    await assert.rejects(transitionRollout(f.db,{...args,evidence:{...evidence,value:{...evidence.value,records:99}}}),/InvalidSignature/);
    const result=await transitionRollout(f.db,{...args,evidence});assert.equal(result.everEncrypted,true);
    await transitionRollout(f.db,{actor:operator(f),expectedGeneration:1,next:'paused'});
    const before=f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all();
    await assert.rejects(client.saveEntry(entry({title:'blocked'})),/DiaryWritesPaused/);
    assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all(),before);
    await assert.rejects(transitionRollout(f.db,{actor:operator(f),expectedGeneration:2,next:'legacy'}),/InvalidRolloutTransition/);
    assert.throws(()=>f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='legacy'"),/PlaintextRollbackForbidden/);
    const plan=rollbackPlan(await readRollout(f.db),{build:'stable-reader-1',workerVersion:'trusted-version-1',formats:[1,2],protocol:1});assert.equal(plan.dataAction,'preserve-ciphertext');
    assert.throws(()=>rollbackPlan(result,{build:'old-plaintext',workerVersion:'old-version',formats:[],protocol:1}),/IncompatibleRollbackTarget/);
    await transitionRollout(f.db,{actor:operator(f),expectedGeneration:2,next:'encrypted',directory:prepared.directory,evidence});
    await client.saveEntry(entry({title:'after resume'}));assert.equal(client.records.size,2);
  }finally{f.close();}
});
test('legacy DB triggers block writes from an old Worker after migration starts',()=>{
  const db=memoryDatabase({phase:'legacy'});try {
    for(const table of ['diary_entries','diary_tags','diary_photos','diary_favorites','diary_photo_upload_sessions','diary_staged_photos'])db.sqlite.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,value TEXT)`);
    db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
    for(const table of ['diary_entries','diary_tags','diary_photos','diary_favorites','diary_photo_upload_sessions','diary_staged_photos'])db.sqlite.exec(`INSERT INTO ${table} VALUES(1,'before')`);
    db.sqlite.exec("UPDATE diary_e2ee_control SET phase='migrating'");
    for(const table of ['diary_entries','diary_tags','diary_photos','diary_favorites','diary_photo_upload_sessions','diary_staged_photos']){
      assert.throws(()=>db.sqlite.exec(`INSERT INTO ${table} VALUES(2,'plaintext')`),/DiaryWritesPaused/);
      assert.throws(()=>db.sqlite.exec(`UPDATE ${table} SET value='plaintext'`),/DiaryWritesPaused/);
    }
  }finally{db.close();}
});
