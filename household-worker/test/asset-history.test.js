import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {fixture} from './fixture.js';

const migration=readFileSync(new URL('../migrations/0004_asset_history_start.sql',import.meta.url),'utf8');
const record=month=>({id:month,month,date:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10),accounts:[{id:'sample',name:'Synthetic account',amount:123}],total:123});

test('asset cutoff physically deletes only old assets across generations, preserves June and invalidates active revisions',()=>{
  for(const activeHasOld of [true,false]){
    const sqlite=new DatabaseSync(':memory:');
    try{
      sqlite.exec('PRAGMA foreign_keys=ON');
      for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')&&n<'0004_').sort())sqlite.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
      const insert=sqlite.prepare('INSERT INTO household_records(dataset_id,kind,id,payload) VALUES(?,?,?,?)');
      for(const dataset of ['initial','old-restore','staging-restore']){
        if(activeHasOld||dataset!=='initial')for(const [kind,month]of [['historical','2018-02'],['snapshots','2022-05']])insert.run(dataset,kind,month,JSON.stringify(record(month)));
        for(const [kind,month]of [['historical','2022-06'],['snapshots','2022-07']])insert.run(dataset,kind,month,JSON.stringify(record(month)));
        for(const kind of ['transactions','accounts','categories'])insert.run(dataset,kind,'legacy',JSON.stringify({id:'legacy',date:'2020-01-01',amount:456}));
      }
      const retained=sqlite.prepare("SELECT * FROM household_records WHERE kind NOT IN ('historical','snapshots') OR id>='2022-06' ORDER BY dataset_id,kind,id").all();
      sqlite.exec(migration);
      assert.deepEqual(sqlite.prepare('SELECT * FROM household_records ORDER BY dataset_id,kind,id').all(),retained);
      assert.equal(sqlite.prepare('SELECT revision FROM household_state').get().revision,Number(activeHasOld));
      assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
      for(const kind of ['historical','snapshots']){
        assert.throws(()=>insert.run('initial',kind,'2022-05',JSON.stringify(record('2022-05'))),/household_asset_history_before_start/);
        assert.throws(()=>sqlite.prepare('UPDATE household_records SET payload=? WHERE dataset_id=? AND kind=?').run(JSON.stringify(record('2022-05')),'initial',kind),/household_asset_history_before_start/);
        assert.throws(()=>insert.run('initial',kind,'2022-08',JSON.stringify({...record('2022-08'),date:'2022-06-29'})),/household_asset_history_before_start/);
      }
    }finally{sqlite.close();}
  }
});

test('API rejects obsolete assets and old backups, permits the June boundary and old transactions, and protects stale clients',async()=>{
  const f=fixture();try{
    await f.login();const before=await f.state();
    f.sqlite.exec('DROP TRIGGER household_asset_cutoff_insert; DROP TRIGGER household_asset_cutoff_update;');
    f.sqlite.prepare("INSERT INTO household_records(dataset_id,kind,id,payload) VALUES('initial','historical','2022-05',?)").run(JSON.stringify(record('2022-05')));
    f.sqlite.exec(migration);
    assert.equal((await f.mutate('snapshot.save',record('2022-06'),{expectedRevision:before.revision})).status,409);
    for(const kind of ['snapshot','historical']){
      const response=await f.mutate(`${kind}.save`,record('2022-05'));
      assert.equal(response.status,400);assert.match((await response.json()).error,/2022年6月/);
      assert.equal((await f.mutate(`${kind}.save`,record('2022-06'))).status,200);
    }
    const state=await f.state();
    assert.equal((await f.mutate('transaction.save',{id:crypto.randomUUID(),date:'2020-01-01',type:'income',amount:456,description:'Synthetic old transaction',notes:'',categoryId:state.data.categories.find(c=>c.type==='income').id,accountId:null,included:true})).status,200);
    const retained=await f.state(),oldBackup=await (await f.request('/api/backup')).json();
    oldBackup.data.historical.push(record('2022-05'));
    const response=await f.request('/api/restore',{requestId:crypto.randomUUID(),expectedRevision:retained.revision,backup:oldBackup});
    assert.equal(response.status,400);assert.deepEqual(await f.state(),retained);
  }finally{f.close();}
});
