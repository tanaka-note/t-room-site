import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {systemFixture} from './system-fixture.mjs';
import {entry} from './fixture.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {LEGACY_TABLES,prepareMigration} from '../../e2ee/migration.mjs';
import {verifyLegacyCoverage} from '../../e2ee/migration-store.mjs';
import {rotationDigest} from '../../e2ee/rotation.mjs';
import {handleDiaryKeys} from '../../../security-worker/src/diary-keys.js';
import {signed} from '../../e2ee/crypto.mjs';
import {backup,restoreEmpty} from '../../e2ee/backup.mjs';
import {memoryDatabase} from './sqlite.mjs';
import {createStore} from '../../e2ee/store.mjs';

test('initial migration preserves existing D1 data and photo bytes, then every authorized account writes ciphertext',async()=>{
  const f=await systemFixture({phase:'legacy'}),owner=f.users['main-admin'],clients=[];
  const central=(path,body,user=owner)=>handleDiaryKeys('/api/diary'+path.split('?')[0],new Request('https://fixture.test/security/api/diary'+path,
    {method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}),f.centralEnv,{...user,authenticatedAt:Date.now()/1000},f.helpers);
  const request=async(user,path,body)=>{
    const origin=f.env.DIARY_ENCRYPTION_ORIGIN,method=body===undefined?'GET':'POST';
    const response=await f.worker.fetch(new Request(origin+'/diary/api/encryption'+path,{method,
      headers:{Cookie:f.cookie(user.serviceAccountId,user),...(method==='POST'?{Origin:origin,'X-Diary-Request':'1','Content-Type':'application/json'}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env,f.ctx);
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});return result;
  };
  const client=async(user=owner)=>{
    const {profile}=await request(user,'/profile');
    const c=new EncryptedDiaryClient({profile,anchor:f.configuration.anchor,transport:{valid:async()=>true,
      timestamp:async()=>new Date().toISOString(),snapshot:(h,since)=>readSnapshotPages(options=>request(user,'/snapshot?'+new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))),h,since),
      mutation:(proposal,operation)=>request(user,'/mutation',{proposal,operation})}});
    await c.unlock(new Uint8Array(user.prf));clients.push(c);return c;
  };
  try {
    const photoId=crypto.randomUUID(),photoId2=crypto.randomUUID();
    const content=`  LEGACY_WHITESPACE\n[[写真:${photoId2}]]\n[[写真:${photoId}]]  `;
    const insert=f.db.sqlite.prepare('INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status,revision,deleted_at,draft_of_entry_id,draft_of_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(101,'2026-11-01','LEGACY_TITLE',content,'wife-admin','Legacy author','tanaka-household','published',7,null,null,null);
    insert.run(102,'2026-11-02','LEGACY_DRAFT',content,'main-user','Legacy user','tanaka-household','draft',3,null,101,7);
    insert.run(103,'2026-11-03','LEGACY_TRASH',content,'wife-admin','Legacy author','tanaka-household','published',4,'2026-11-04',null,null);
    insert.run(104,'2026-11-01','OTHER_HOUSE','Other contents','chiharu-admin','Other author','chiharu-household','published',2,null,null,null);
    f.db.sqlite.prepare("INSERT INTO diary_trash_scopes(entry_id,owner_account_id,household_id,scope_type,entry_revision) VALUES(103,'wife-admin','tanaka-household','personal',4)").run();
    f.db.sqlite.exec("INSERT INTO diary_tags(entry_id,tag,sort_order) VALUES(101,'second',1),(101,'first',0); INSERT INTO diary_favorites(account_id,entry_id) VALUES('main-user',101),('wife-admin',101)");
    for(const [id,time] of [[photoId,'2026-11-01'],[photoId2,'2026-11-02']]) {
      f.db.sqlite.prepare("INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name,created_at) VALUES(?,101,'OLD_PRIVATE_NAME.jpg','image/jpeg',3,?,?,?,'wife-admin','Legacy author',?)")
        .run(id,'diary/staging/'+id+'/original','diary/staging/'+id+'/display','diary/staging/'+id+'/thumb',time);
      f.r2.set('diary/staging/'+id+'/original',{bytes:new Uint8Array([1,2,3])});
    }
    f.db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
    const oldR2=structuredClone([...f.r2]);
    await assert.rejects(central('/migration/inventory?table=diary_entries'),/MigrationRequiresFrozenLegacyDatabase/);
    await central('/control',{expectedGeneration:0,next:'migrating',evidence:null});
    await assert.rejects(central('/migration/inventory?table=security_credentials'),/InvalidMigrationPage/);
    assert.equal((await (await central('/migration/inventory?table=diary_entries&limit=100')).json()).rows.length,4);
    await assert.rejects(central('/migration/inventory?table=diary_entries&limit=101'),/InvalidMigrationPage/);
    const source={};
    for(const table of LEGACY_TABLES) {
      source[table]=[];let after=0;
      do{const page=await (await central('/migration/inventory?'+new URLSearchParams({table,after}))).json();source[table].push(...page.rows);after=page.nextCursor;}while(after!==null);
    }
    const plan=await prepareMigration({source,configuration:{...f.configuration,generation:1},recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor});
    assert.equal(plan.records.length,6);assert.equal(plan.media.length,2);
    assert.equal(JSON.stringify(plan).includes('LEGACY_TITLE'),false);
    assert.equal(JSON.stringify(plan).includes('OLD_PRIVATE_NAME'),false);
    await assert.rejects(verifyLegacyCoverage(f.db),/IncompleteLegacyMigration/);
    for(const kind of ['records','media']) {
      await central('/migration/import',{kind,rows:plan[kind],expectedGeneration:1});
      await central('/migration/import',{kind,rows:plan[kind],expectedGeneration:1});
    }
    await verifyLegacyCoverage(f.db);
    assert.equal((await (await central('/maintenance/inventory?kind=media&limit=100')).json()).rows.length,2);
    await assert.rejects(central('/maintenance/inventory?kind=media&limit=101'),/InvalidMaintenancePage/);
    const repeated=await prepareMigration({source,configuration:{...f.configuration,generation:1},recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor});
    await assert.rejects(central('/migration/import',{kind:'records',rows:repeated.records,expectedGeneration:1}),/MigrationRetryConflict/);
    const resume={source,configuration:{...f.configuration,generation:1},recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor,existing:plan};
    assert.deepEqual(await prepareMigration(resume),plan,'another device adopts identical ciphertext only after checking every plaintext and binding');
    const partial=await prepareMigration({...resume,existing:{records:plan.records.slice(0,2),media:plan.media.slice(0,1)}});
    assert.deepEqual(partial.records.slice(0,2),plan.records.slice(0,2));assert.deepEqual(partial.media[0],plan.media[0]);
    const changedSource=structuredClone(source);changedSource.diary_entries[0].content+=' changed';
    await assert.rejects(prepareMigration({...resume,source:changedSource}),/MigrationContentMismatch/);
    const changedMedia=structuredClone(plan);changedMedia.media[0].original_key+='-different-object';
    await assert.rejects(prepareMigration({...resume,existing:changedMedia}),/MigrationContentMismatch/);
    const corrupted=structuredClone(plan);corrupted.media[0].metadata=corrupted.media[0].metadata.replace(/ciphertext":"./,'ciphertext":"!');
    await assert.rejects(prepareMigration({...resume,existing:corrupted}));
    await assert.rejects(prepareMigration({...resume,existing:{records:[...plan.records,plan.records[0]],media:plan.media}}),/InvalidMigrationInventory/);
    await assert.rejects(prepareMigration({...resume,existing:{records:plan.records,media:[...plan.media,{...plan.media[0],id:'unexpected'}]}}),/UnexpectedMigrationCiphertext/);
    assert.deepEqual([...f.r2],oldR2);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_entries').get().count,4);
    assert.throws(()=>f.db.sqlite.exec("UPDATE diary_entries SET content='PLAINTEXT_AFTER_FREEZE' WHERE id=101"),/DiaryWritesPaused/);
    const admin=await client(),reader=await client(f.users['main-user']),wife=await client(f.users['wife-admin']);await admin.sync();await reader.sync();await wife.sync();
    assert.equal(admin.entry(101).content,content);
    assert.equal(reader.entry(101).isFavorite,true);
    assert.equal(wife.entry(101).isFavorite,true);
    assert.equal(wife.entry(103).title,'LEGACY_TRASH');
    assert.deepEqual(admin.entry(101).tags,['first','second']);
    assert.deepEqual(admin.entry(101).photos.map(p=>p.id),[photoId2,photoId]);
    assert.deepEqual(admin.entry(102).photos.map(p=>p.id),[photoId2,photoId]);
    await assert.rejects(reader.saveEntry(entry()),e=>e.status===423);
    const archive=await backup(f.db,{directory:f.configuration.directory,vaults:Object.fromEntries(Object.values(f.users).map(user=>[user.recipientId,user.vault])),grants:f.configuration.grants,recordGrants:f.configuration.recordGrants,recoveryEnvelope:f.configuration.recoveryEnvelope});
    const isolated=memoryDatabase({phase:'legacy'});
    try {
      const restored=await restoreEmpty(isolated,archive,{anchor:f.configuration.anchor,minimumGeneration:1});assert.equal(restored.records,6);
      const store=createStore(isolated,{directory:f.configuration.directory.value,epochs:f.configuration.directory.value.epochs,households:f.configuration.directory.value.households,photos:{}});
      const original=reader.transport.snapshot;reader.transport.snapshot=(h,since)=>store.snapshot(reader.actor,h,since);reader.sequence=undefined;reader.records.clear();await reader.sync();
      assert.equal(reader.entry(101).content,content);assert.equal(reader.entry(101).isFavorite,true);reader.transport.snapshot=original;
    }finally{isolated.close();}
    const sequence=f.db.sqlite.prepare('SELECT MAX(seq) sequence FROM diary_e2ee_changes').get().sequence;
    const proof=await signed({protocol:'T-lain diary cutover',version:2,records:6,sequence,directoryGeneration:1,
      sourceManifestDigest:await rotationDigest(plan),restoreDigest:await rotationDigest(archive),readerBuild:'fixture-reader',writerBuild:'fixture-writer',formats:[1,2]},admin.privateKeys.sign);
    await central('/control',{expectedGeneration:1,next:'encrypted',evidence:proof});
    for(const table of LEGACY_TABLES)assert.equal(f.db.sqlite.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count,0);
    for(const user of Object.values(f.users)) {
      const c=await client(user);await c.saveEntry({...entry(),title:'POST_FROM_'+user.serviceAccountId});
    }
    assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes('POST_FROM_'),false);
    const response=await f.worker.fetch(new Request(f.env.DIARY_ENCRYPTION_ORIGIN+'/diary/api/entries',{method:'POST',headers:{Cookie:f.cookie(),Origin:f.env.DIARY_ENCRYPTION_ORIGIN,'X-Diary-Request':'1','Content-Type':'application/json'},body:JSON.stringify(entry())}),f.env,f.ctx);
    assert.equal(response.status,426);
    assert.deepEqual([...f.r2],oldR2);
  }finally{for(const c of clients)c.lock();await f.close();}
});
