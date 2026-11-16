import assert from 'node:assert/strict';import {test} from 'node:test';import {readFileSync} from 'node:fs';
import {systemFixture} from './system-fixture.mjs';
import {prepareDiaryMaintenance,finishDiaryMaintenance,resumeVerifiedMaintenance} from '../../e2ee/maintenance.mjs';
import {handleDiaryKeys} from '../../../security-worker/src/diary-keys.js';
import {unlockVault} from '../../e2ee/crypto.mjs';
import {saveExport} from '../../../backup-worker/src/export-backup.js';
import {DIARY_ENCRYPTED_MIGRATION} from '../../../backup-worker/src/diary-encrypted.js';
import {restoreIsolated,diaryRestoreReport} from '../../../backup-worker/tools/restore-isolated.mjs';
import {Bucket} from '../../../backup-worker/test/fixtures.mjs';
import {exportFetcher,exportEnv} from '../../../backup-worker/test/export-fixtures.mjs';

test('trusted-device maintenance resumes an interrupted import and only cuts over after actual isolated restore and local decryption',async()=>{
  const f=await systemFixture({phase:'legacy'}),bucket=new Bucket(),owner=f.users['main-admin'];let restored;
  try {
    f.db.sqlite.exec("INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status,revision) VALUES(10,'2026-11-15','PRIVATE_MIGRATION_TITLE','PRIVATE_MIGRATION_CONTENT','wife-admin','Legacy author','tanaka-household','published',9);INSERT INTO diary_favorites(account_id,entry_id) VALUES('main-user',10)");
    const central=async(path,body)=>{const response=await handleDiaryKeys('/api/diary'+path.split('?')[0],new Request('https://fixture.test/security/api/diary'+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}),f.centralEnv,{...owner,authenticatedAt:Date.now()/1000},f.helpers);return response.json();};
    f.db.sqlite.exec("WITH RECURSIVE n(v) AS (SELECT 11 UNION ALL SELECT v+1 FROM n WHERE v<56) INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status,revision) SELECT v,'2026-11-15','Other title','Other content','main-admin','Author','tanaka-household','published',1 FROM n");
    let pending=null,progress=null,proof=null,loseBeforeControl=false,loseImport=true,loseCutover=false,importCalls=0;
    f.db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
    const plans={get:async()=>structuredClone(pending),put:async plan=>{pending=structuredClone(plan);progress=null;},getProgress:async()=>structuredClone(progress),getProof:async()=>structuredClone(proof),putProof:async value=>{proof=structuredClone(value);},putProgress:async value=>{progress=structuredClone(value);},clear:async()=>{pending=null;progress=null;proof=null;}};
    const api=async(path,body)=>{
      if(path==='/control'&&body.next==='encrypted'&&loseBeforeControl){loseBeforeControl=false;throw new Error('RecentAuthenticationRequired');}
      const result=await central(path,body);
      if(path==='/migration/import'&&++importCalls===2&&loseImport){loseImport=false;throw new Error('ResponseLost');}
      if(path==='/control'&&body.next==='encrypted'&&loseCutover){loseCutover=false;throw new Error('ResponseLost');}
      return result;
    };
    const trust={anchor:f.configuration.anchor,minimumGeneration:1},options={kind:'migration',api,recoveryPrivateKey:f.recovery.privateKey,trust,plans};
    await assert.rejects(prepareDiaryMaintenance(options),/ResponseLost/);
    assert.equal(progress.records,20);
    assert.ok(pending);assert.equal(JSON.stringify(pending).includes('PRIVATE_MIGRATION_CONTENT'),false);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
    assert.equal((await prepareDiaryMaintenance(options)).requiresRestoreDrill,true);
    const vault=await unlockVault(new Uint8Array(owner.prf),owner.recipientId,owner.vault);
    const env={...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central};
    const backup=async()=>{
      const mock=exportFetcher(f.db.sqlite,'diary',{migration:DIARY_ENCRYPTED_MIGRATION});
      const saved=await saveExport(env,'diary',Date.now(),{checkpoint:crypto.randomUUID(),fetcher:mock.fetcher,sleep:async()=>{}});
      assert.match(saved.daily,/^v10\/checkpoints\//);assert.equal(saved.monthly,null);
      return restoreIsolated(bucket,saved.daily,'diary',{anchor:trust.anchor,minimumGeneration:trust.minimumGeneration});
    };
    restored=await backup();const report=diaryRestoreReport(restored);
    assert.equal(report.records.length,48);assert.equal(JSON.stringify(report).includes('PRIVATE_MIGRATION_CONTENT'),false);
    const finish={api,recoveryPrivateKey:f.recovery.privateKey,signingKey:vault.sign,trust,plans,report,readerBuild:'diary-0123456789ab',writerBuild:'diary-0123456789ab'};
    const missing=structuredClone(report);missing.records.pop();
    await assert.rejects(finishDiaryMaintenance({...finish,report:missing}));
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_entries').get().count,47);
    loseBeforeControl=true;
    await assert.rejects(finishDiaryMaintenance(finish),/RecentAuthenticationRequired/);
    assert.ok(proof);assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
    assert.equal(JSON.stringify(proof).includes('PRIVATE_MIGRATION_CONTENT'),false);
    const originalProof=structuredClone(proof);
    proof.value.sequence++;
    assert.equal(await resumeVerifiedMaintenance(finish),null,'an invalid optional proof cannot authorize a cutover and requires a full drill');
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
    proof=originalProof;
    const changed=async(path,body)=>{
      const result=await api(path,body);
      if(path.startsWith('/maintenance/inventory?')&&result.rows.length&&new URLSearchParams(path.split('?')[1]).get('kind')==='records')result.rows[0].envelope.ciphertext='ChangedCiphertext';
      return result;
    };
    await assert.rejects(resumeVerifiedMaintenance({...finish,api:changed}),/RestoreInventoryMismatch/);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
    loseCutover=true;
    await assert.rejects(resumeVerifiedMaintenance(finish),/ResponseLost/);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
    assert.ok(pending);await resumeVerifiedMaintenance(finish);assert.equal(pending,null);assert.equal(proof,null);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_entries').get().count,0);
    restored.db.close();restored=null;
    // The same path handles revocation and personal preferences without their
    // original owner's signature. A new same-day checkpoint avoids reusing the
    // pre-rotation daily snapshot or overwriting a good historical generation.
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(f.users['wife-admin'].credentialId);
    await prepareDiaryMaintenance({...options,kind:'rotation'});
    const before=f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase;assert.equal(before,'paused');
    assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,2);
    await prepareDiaryMaintenance({...options,kind:'rotation'});
    restored=await backup();const rotatedReport=diaryRestoreReport(restored);
    assert.equal(rotatedReport.directoryGeneration,2);
    await finishDiaryMaintenance({...finish,report:rotatedReport});assert.equal(pending,null);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
    f.central.sqlite.prepare('DELETE FROM security_diary_key_vaults WHERE recipient_id=?').run(f.users['main-user'].recipientId);
    const status=await api('/admin');assert.deepEqual(status.writerReadiness,{ready:false,missingAccountIds:['main-user']});
    await api('/control',{expectedGeneration:status.rollout.generation,next:'paused',evidence:null});
    await assert.rejects(api('/control',{expectedGeneration:status.rollout.generation+1,next:'encrypted',evidence:status.rollout.evidence}),/DiaryWriterPreparationRequired/);
  }finally{restored?.db.close();await f.close();}
});
