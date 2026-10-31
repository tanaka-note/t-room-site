import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {fixture,household} from './fixture.js';
import {backup,emptyData} from '../src/domain.js';

const id=()=>crypto.randomUUID();
const migrationDir=new URL('../migrations/',import.meta.url);
function family(){
  const owner=fixture(),chiharu=fixture('chiharu-admin','sample-chiharu'),viewer=fixture('viewer');
  chiharu.env.DB=viewer.env.DB=owner.env.DB;
  return {owner,chiharu,viewer,db:owner.sqlite,async login(){await owner.login();await chiharu.login();await viewer.login();},close(){owner.close();chiharu.close();viewer.close();}};
}
const entry=(description,amount=123)=>({id:id(),date:'2026-10-01',type:'expense',categoryId:'builtin-1-0',amount,description});
const bank=name=>({id:id(),name,type:'bank',asOf:'2026-10-01',items:[{id:id(),name:'Balance',amount:456}]});

test('migration retains existing records, receipts, revisions and sessions; Chiharu starts with only standard categories',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('PRAGMA foreign_keys=ON');
    for(const file of readdirSync(migrationDir).filter(n=>n.endsWith('.sql')&&n<'0006_').sort())db.exec(readFileSync(new URL(file,migrationDir),'utf8'));
    db.prepare("INSERT INTO household_records VALUES('initial','categories',?,?)").run(id(),JSON.stringify({id:id(),parent:'その他',name:'Private category',type:'expense',builtin:false}));
    db.exec("INSERT INTO household_requests VALUES('saved-operation','saved-fingerprint','{\"ok\":true,\"revision\":7}','2020-01-01'); UPDATE household_state SET revision=revision+1; INSERT INTO household_datasets(id,retired_at) VALUES('old-dataset','2020-01-01')");
    db.prepare("INSERT INTO household_records VALUES('old-dataset','transactions',?,?)").run(id(),JSON.stringify(entry('Private old entry')));
    const records=db.prepare('SELECT * FROM household_records ORDER BY dataset_id,kind,id').all();
    const accounts=db.prepare('SELECT * FROM household_accounts ORDER BY id').all();
    const state=db.prepare('SELECT * FROM household_state').get();
    const receipts=db.prepare('SELECT * FROM household_requests').all();
    const datasets=db.prepare('SELECT * FROM household_datasets ORDER BY id').all();
    db.exec(readFileSync(new URL('0006_independent_households.sql',migrationDir),'utf8'));
    assert.deepEqual(db.prepare("SELECT * FROM household_records WHERE dataset_id!='chiharu-initial' ORDER BY dataset_id,kind,id").all(),records);
    assert.deepEqual(db.prepare("SELECT id,display_name,role,is_active,session_version FROM household_accounts WHERE household_id='main' ORDER BY id").all(),accounts);
    assert.deepEqual(db.prepare("SELECT * FROM household_state WHERE id='main'").get(),state);
    assert.deepEqual(db.prepare("SELECT request_id,fingerprint,response_json,created_at FROM household_requests WHERE household_id='main'").all(),receipts);
    assert.deepEqual(db.prepare("SELECT id,created_at,activated_at,retired_at,lease_expires_at FROM household_datasets WHERE household_id='main' ORDER BY id").all(),datasets);
    assert.deepEqual(db.prepare("SELECT id,display_name,role FROM household_accounts WHERE household_id='chiharu'").all().map(r=>({...r})),[{id:'chiharu-admin',display_name:'田中千晴',role:'owner'}]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM household_records WHERE dataset_id='chiharu-initial' AND kind!='categories'").get().n,0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.throws(()=>db.exec("UPDATE household_state SET revision=99 WHERE id='main'"),/household_revision_conflict/);
  }finally{db.close();}
});

test('independent data, standard categories, revisions, summaries, exports and backup; existing viewer sees only the original household',async()=>{
  const f=family();try{
    await f.login();
    const initial=await f.chiharu.state();
    assert.equal(initial.revision,0);assert.deepEqual(initial.data,emptyData());assert.deepEqual(initial.assetHistory,[]);
    const provider=new household.SecurityIntegration({},f.owner.env),targets=(await provider.listLinkTargets()).targets;
    const target=targets.find(t=>t.accountId==='chiharu-admin');
    assert.equal(target.displayLabel,'田中千晴');assert.equal(target.role,'owner');assert.equal(target.exclusive,true);assert.equal(target.privileged,true);assert.equal(target.shared,false);
    assert.deepEqual(targets.filter(t=>t.accountId.includes('chiharu')).map(t=>t.accountId),['chiharu-admin']);
    for(const [client,label]of [[f.owner,'Original private'],[f.chiharu,'Chiharu private']]){
      assert.equal((await client.mutate('transaction.save',entry(label))).status,200);
      assert.equal((await client.mutate('account.save',bank(label))).status,200);
      assert.equal((await client.mutate('category.save',{id:id(),parent:'その他',name:label})).status,200);
    }
    const original=await f.owner.state(),chiharu=await f.chiharu.state();
    assert.equal(original.revision,3);assert.equal(chiharu.revision,3);
    assert.deepEqual((await f.viewer.state()).data,original.data);
    assert.equal(chiharu.data.accounts.length,1);assert.equal(chiharu.data.accounts[0].name,'Chiharu private');
    assert.equal(chiharu.assetHistory.at(-1).total,456);
    for(const [client,own,other]of [[f.owner,'Original private','Chiharu private'],[f.chiharu,'Chiharu private','Original private'],[f.viewer,'Original private','Chiharu private']]){
      const csv=await (await client.request('/api/export.csv')).text();assert.ok(csv.includes(own));assert.ok(!csv.includes(other));
      const saved=await (await client.request('/api/backup')).text();assert.ok(saved.includes(own));assert.ok(!saved.includes(other));assert.ok(!saved.includes('householdId'));
    }
    // Body/query scopes cannot select a different household; foreign deletes are harmless.
    assert.deepEqual((await (await f.chiharu.request('/api/data?householdId=main')).json()).data,chiharu.data);
    const originalDataset=f.db.prepare("SELECT active_dataset FROM household_state WHERE id='main'").get().active_dataset;
    assert.equal((await f.chiharu.mutate('transaction.delete',{id:original.data.transactions[0].id},{householdId:'main',datasetId:originalDataset,serviceAccountId:'owner'})).status,200);
    assert.deepEqual(await f.owner.state(),original);assert.deepEqual((await f.chiharu.state()).data,chiharu.data);
    assert.equal((await f.viewer.mutate('transaction.save',entry('Forbidden'))).status,403);
  }finally{f.close();}
});

test('request IDs and concurrent restore/revision checks are isolated to each household',async()=>{
  const f=family();try{
    await f.login();const requestId=id();
    const save=(client,label)=>client.request('/api/mutate',{requestId,expectedRevision:0,operation:'transaction.save',value:entry(label)});
    const responses=await Promise.all([save(f.owner,'Original'),save(f.chiharu,'Chiharu')]);assert.deepEqual(responses.map(r=>r.status),[200,200]);
    const original=await f.owner.state(),chiharu=await f.chiharu.state();
    assert.equal(original.data.transactions[0].description,'Original');assert.equal(chiharu.data.transactions[0].description,'Chiharu');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_requests WHERE request_id=?').get(requestId).n,2);
    const restoreId=id(),body={requestId:restoreId,expectedRevision:1,backup:backup(emptyData()),householdId:'main'};
    const restored=await Promise.all([f.owner.request('/api/restore',body),f.chiharu.request('/api/restore',body)]);assert.deepEqual(restored.map(r=>r.status),[200,200]);
    for(const client of [f.owner,f.chiharu]){assert.equal((await client.request('/api/restore',body)).status,200);assert.equal((await client.state()).revision,2);assert.deepEqual((await client.state()).data,emptyData());}
    assert.equal(f.db.prepare('SELECT COUNT(DISTINCT active_dataset) n FROM household_state').get().n,2);
    for(const row of f.db.prepare('SELECT s.id,d.household_id FROM household_state s JOIN household_datasets d ON d.id=s.active_dataset').all())assert.equal(row.id,row.household_id);
    assert.equal((await f.chiharu.request('/api/mutate',{requestId:id(),expectedRevision:1,operation:'transaction.save',value:entry('Stale')})).status,409);
  }finally{f.close();}
});

test('failed Chiharu restore preserves both active households, and foreign active generations fail closed',async()=>{
  const f=family();try{
    await f.login();const original=await f.owner.state(),chiharu=await f.chiharu.state(),batch=f.chiharu.env.DB.batch;let calls=0;
    f.chiharu.env.DB={...f.chiharu.env.DB,async batch(statements){if(++calls===2)throw new Error('Synthetic restore failure');return batch(statements);}};
    assert.equal((await f.chiharu.request('/api/restore',{requestId:id(),expectedRevision:0,backup:backup(emptyData())})).status,503);
    assert.deepEqual(await f.owner.state(),original);assert.deepEqual(await f.chiharu.state(),chiharu);
    f.db.exec("INSERT INTO household_datasets(id,household_id) VALUES('private-retired','main')");
    f.db.prepare("UPDATE household_state SET revision=revision+1,active_dataset=? WHERE id='chiharu'").run('private-retired');
    assert.equal((await f.chiharu.request('/api/data')).status,503);
  }finally{f.close();}
});

test('pre-migration cookies keep working only for the original household until its safe UI update',async()=>{
  const f=family();try{
    await f.login();
    for(const [client,status]of [[f.owner,200],[f.viewer,200],[f.chiharu,401]]){
      const payload=JSON.parse(Buffer.from(client.cookie.split('=')[1].split('.')[0],'base64url'));delete payload.contextVersion;
      const cookie='troom_household_session='+await household.signSession(payload,client.env);
      const response=await client.worker.fetch(new Request('https://example.test/household/api/data',{headers:{Cookie:cookie}}));
      assert.equal(response.status,status);
    }
  }finally{f.close();}
});

test('cleanup previews, retained generations and identical receipt IDs are scoped to the current household',async()=>{
  const f=family();try{
    await f.login();
    for(const scope of ['main','chiharu']){
      for(let i=0;i<5;i++){
        const dataset=`${scope}-old-${i}`;
        f.db.prepare('INSERT INTO household_datasets(id,household_id,created_at,activated_at,retired_at) VALUES(?,?,?, ?,?)').run(dataset,scope,'2020-01-01','2020-01-01',`2020-01-0${i+1}`);
        f.db.prepare("INSERT INTO household_records VALUES(?,'transactions','synthetic','{}')").run(dataset);
      }
      f.db.prepare("INSERT INTO household_requests(household_id,request_id,fingerprint,response_json,created_at) VALUES(?,'same-old-id','synthetic','{}','2020-01-01')").run(scope);
    }
    const mainRows=()=>({state:f.db.prepare("SELECT * FROM household_state WHERE id='main'").all(),datasets:f.db.prepare("SELECT * FROM household_datasets WHERE household_id='main' ORDER BY id").all(),requests:f.db.prepare("SELECT * FROM household_requests WHERE household_id='main'").all(),records:f.db.prepare("SELECT r.* FROM household_records r JOIN household_datasets d ON r.dataset_id=d.id WHERE d.household_id='main' ORDER BY r.dataset_id,r.kind,r.id").all()});
    const before=mainRows();
    const mainPlan=await (await f.owner.request('/api/maintenance/preview')).json(),plan=await (await f.chiharu.request('/api/maintenance/preview')).json();
    assert.equal(plan.requestCount,1);assert.equal(plan.datasetCount,2);assert.notEqual(plan.planFingerprint,mainPlan.planFingerprint);
    const body={requestId:id(),expectedRevision:0,planFingerprint:plan.planFingerprint,confirmCleanup:true};
    assert.equal((await f.chiharu.request('/api/maintenance',{...body,planFingerprint:mainPlan.planFingerprint})).status,409);
    assert.equal((await f.chiharu.request('/api/maintenance',body)).status,200);assert.equal((await f.chiharu.request('/api/maintenance',body)).status,200);
    assert.deepEqual(mainRows(),before);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM household_requests WHERE household_id='chiharu' AND request_id='same-old-id'").get().n,0);
    assert.deepEqual(f.db.prepare("SELECT id FROM household_datasets WHERE household_id='chiharu' ORDER BY id").all().map(r=>r.id),['chiharu-initial','chiharu-old-2','chiharu-old-3','chiharu-old-4']);
  }finally{f.close();}
});

test('a stale page cannot read, export, update, restore or clean up using another login cookie',async()=>{
  const f=family();try{
    await f.login();const oldContext=(await (await f.owner.request('/api/session')).json()).sessionContext;
    const before=await f.chiharu.state();
    for(const headers of [{'X-Household-Session':oldContext},{'X-Household-Session':''}]){
      for(const path of ['/api/data','/api/backup','/api/export.csv','/api/maintenance/preview'])assert.equal((await f.chiharu.request(path,undefined,headers)).status,401,path);
      for(const path of ['/api/mutate','/api/restore','/api/maintenance','/api/logout'])assert.equal((await f.chiharu.request(path,{},headers)).status,401,path);
    }
    assert.equal((await f.chiharu.request('/api/session',undefined,{'X-Household-Session':oldContext})).status,401);
    assert.deepEqual(await f.chiharu.state(),before);
    f.db.exec("UPDATE household_accounts SET is_active=0 WHERE id='chiharu-admin'");
    assert.equal((await f.chiharu.request('/api/data')).status,401);
  }finally{f.close();}
});
