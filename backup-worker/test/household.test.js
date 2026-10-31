import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database,d1,Bucket,recorder} from './fixtures.mjs';
import {backupService} from '../src/backup.js';
import {restoreIsolated} from '../tools/restore-isolated.mjs';
import {getBackupSnapshot} from '../src/browser.js';
import {dataFromRecords,mutateData,records} from '../../household-worker/src/domain.js';

test('Household joins the existing private daily/monthly backup and restores active and retained data without granting access',async()=>{
  const db=database('household'),bucket=new Bucket(),audit=recorder();let restored;
  try{
    const current=dataFromRecords(db.prepare("SELECT kind,id,payload FROM household_records WHERE dataset_id='initial'").all());
    const next=mutateData(current,'transaction.save',{id:crypto.randomUUID(),date:'2026-10-31',type:'expense',amount:12345,categoryId:current.categories.find(c=>c.type==='expense').id,description:'synthetic household expense',notes:'fixture only'});
    const insert=db.prepare('INSERT INTO household_records VALUES(?,?,?,?)');
    for(const row of records(next))insert.run('restored-generation',row.kind,row.id,row.payload);
    db.exec("INSERT INTO household_datasets(id,household_id) VALUES('restored-generation','main'); UPDATE household_state SET revision=revision+1,active_dataset='restored-generation' WHERE id='main'; INSERT INTO household_requests(request_id,fingerprint,response_json) VALUES('synthetic-replay','fixture','{\"ok\":true,\"revision\":1}')");
    const chiharu=mutateData(dataFromRecords(db.prepare("SELECT kind,id,payload FROM household_records WHERE dataset_id='chiharu-initial'").all()),'transaction.save',{id:crypto.randomUUID(),date:'2026-10-31',type:'expense',amount:456,categoryId:current.categories.find(c=>c.type==='expense').id,description:'independent synthetic expense'});
    db.prepare("INSERT INTO household_records VALUES('chiharu-initial','transactions',?,?)").run(chiharu.transactions[0].id,JSON.stringify(chiharu.transactions[0]));
    db.exec("UPDATE household_state SET revision=revision+1 WHERE id='chiharu'; INSERT INTO household_requests(household_id,request_id,fingerprint,response_json) VALUES('chiharu','synthetic-replay','independent','{\"ok\":true,\"revision\":1}')");
    const original=db.prepare('SELECT dataset_id,kind,id,payload FROM household_records ORDER BY dataset_id,kind,id').all();
    const state=db.prepare('SELECT * FROM household_state ORDER BY id').all();
    const requests=db.prepare('SELECT * FROM household_requests ORDER BY household_id,request_id').all();
    const datasets=db.prepare('SELECT * FROM household_datasets ORDER BY id').all();
    const env={HOUSEHOLD_DB:d1(db),BACKUP:bucket,...audit};
    assert.equal((await backupService(env,'household',Date.parse('2026-10-31T00:00:00Z'),async()=>{})).state,'ok');
    assert.ok(bucket.objects.has('d1/household/v2/monthly/2026-10.json.gz'));
    restored=await restoreIsolated(bucket,'d1/household/v2/daily/2026-10-31.json.gz','household');
    assert.deepEqual(restored.db.prepare('SELECT dataset_id,kind,id,payload FROM household_records ORDER BY dataset_id,kind,id').all(),original);
    assert.deepEqual(restored.db.prepare('SELECT * FROM household_state ORDER BY id').all(),state);
    assert.deepEqual(restored.db.prepare('SELECT * FROM household_requests ORDER BY household_id,request_id').all(),requests);
    assert.deepEqual(restored.db.prepare('SELECT * FROM household_datasets ORDER BY id').all(),datasets);
    assert.deepEqual(restored.db.prepare('SELECT id,household_id,is_active,session_version FROM household_accounts ORDER BY id').all().map(r=>({...r})),[{id:'chiharu-admin',household_id:'chiharu',is_active:0,session_version:2},{id:'owner',household_id:'main',is_active:0,session_version:2},{id:'viewer',household_id:'main',is_active:0,session_version:2}]);
    assert.deepEqual(db.prepare('SELECT dataset_id,kind,id,payload FROM household_records ORDER BY dataset_id,kind,id').all(),original,'backup must not mutate source');
    assert.ok(audit.events.some(e=>e.service==='household'&&e.eventType==='backup_succeeded'));
    const snapshot=await getBackupSnapshot({...env,SECURITY_DB:{prepare(){return{bind(){return{async all(){return{results:[]};}};}};}}},false,null);
    const item=snapshot.services.find(s=>s.id==='household');assert.equal(item.label,'家計簿');assert.equal(item.daily.length,1);assert.equal(item.monthly.length,1);
    const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));assert.equal(config.d1_databases.find(d=>d.binding==='HOUSEHOLD_DB').database_name,'household-db');assert.deepEqual(config.r2_buckets,[{binding:'BACKUP',bucket_name:'t-room-service-backups'}]);
  }finally{restored?.db.close();db.close();}
});

test('a cached Backup-data list without Household is refreshed immediately',async()=>{
 const bucket=new Bucket();let lists=0;const list=bucket.list.bind(bucket);bucket.list=async opts=>{lists++;return list(opts);};
 const cache={async match(){return Response.json({services:[{id:'cloud'}],observedAt:new Date().toISOString()});},async put(){}};
 const db={prepare(){return{bind(){return{async all(){return{results:[]};}};}};}};
 const snapshot=await getBackupSnapshot({BACKUP:bucket,SECURITY_DB:db},false,cache);
 assert.ok(lists>0);assert.ok(snapshot.services.some(s=>s.id==='household'));
});
