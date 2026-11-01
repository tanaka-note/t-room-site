import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.js';
import {backup,emptyData,restoreInput} from '../src/domain.js';

const id=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`;
const entry=(n,date='2026-09-01',extra={})=>({id:id(n),date,type:'expense',categoryId:'builtin-1-0',amount:100,description:`Sample ${n}`,notes:'',accountId:null,toAccountId:null,included:true,...extra});
const orders=state=>Object.fromEntries(state.data.transactions.map(t=>[t.id,t.registrationOrder]));

test('server registration order survives edits, date changes, reload, backup/restore and CSV export',async()=>{
  const f=fixture();try{
    await f.login();
    // IDs deliberately run against registration order. Later registration targets an older date.
    for(const row of [entry(30),entry(20,'2026-09-03'),entry(10,'2026-09-01',{registrationOrder:-999})])assert.equal((await f.mutate('transaction.save',row)).status,200);
    const expected={[id(30)]:1,[id(20)]:2,[id(10)]:3};assert.deepEqual(orders(await f.state()),expected);
    assert.equal((await f.mutate('transaction.save',entry(30,'2026-09-03',{registrationOrder:999}))).status,200);
    assert.equal((await f.mutate('transaction.save',entry(30))).status,200);
    assert.deepEqual(orders(await f.state()),expected);
    const csv=await (await f.request('/api/export.csv')).text();
    assert.ok(csv.indexOf('Sample 30')<csv.indexOf('Sample 10'));assert.ok(csv.indexOf('Sample 10')<csv.indexOf('Sample 20'));
    const saved=await (await f.request('/api/backup')).json();assert.deepEqual(orders({data:restoreInput(saved)}),expected);
    assert.equal((await f.request('/api/restore',{requestId:crypto.randomUUID(),expectedRevision:(await f.state()).revision,backup:saved})).status,200);
    assert.deepEqual(orders(await f.state()),expected);
    assert.equal((await f.mutate('transaction.save',entry(1))).status,200);assert.equal(orders(await f.state())[id(1)],4);
    assert.equal((await f.mutate('transaction.delete',{id:id(20)})).status,200);
    assert.equal((await f.mutate('transaction.save',entry(2))).status,200);assert.equal(orders(await f.state())[id(2)],5);
  }finally{f.close();}
});

test('legacy records retain their former same-day ID order before new registrations, including after editing',async()=>{
  const f=fixture();try{
    await f.login();const dataset=f.sqlite.prepare("SELECT active_dataset FROM household_state WHERE id='main'").get().active_dataset;
    const insert=f.sqlite.prepare("INSERT INTO household_records VALUES(?,'transactions',?,?)");
    for(const row of [entry(30),entry(20)])insert.run(dataset,row.id,JSON.stringify(row));
    const untouched=f.sqlite.prepare("SELECT payload FROM household_records WHERE dataset_id=? AND kind='transactions' AND id=?").get(dataset,id(20)).payload;
    assert.equal((await f.mutate('transaction.save',entry(30))).status,200);assert.equal(orders(await f.state())[id(30)],0);
    assert.equal((await f.mutate('transaction.save',entry(1))).status,200);assert.equal(orders(await f.state())[id(1)],1);
    assert.equal(f.sqlite.prepare("SELECT payload FROM household_records WHERE dataset_id=? AND kind='transactions' AND id=?").get(dataset,id(20)).payload,untouched);
    const csv=await (await f.request('/api/export.csv')).text();assert.ok(csv.indexOf('Sample 20')<csv.indexOf('Sample 30'));assert.ok(csv.indexOf('Sample 30')<csv.indexOf('Sample 1'));
    const saved=await (await f.request('/api/backup')).json();assert.deepEqual(restoreInput(saved).transactions,saved.data.transactions);
  }finally{f.close();}
});

test('retries allocate once; competing saves and retries after a revision conflict allocate distinct numbers',async()=>{
  const f=fixture();try{
    await f.login();const body={requestId:crypto.randomUUID(),expectedRevision:0,operation:'transaction.save',value:entry(30)};
    assert.equal((await f.request('/api/mutate',body)).status,200);assert.equal((await f.request('/api/mutate',body)).status,200);
    const bodies=[20,10].map(n=>({requestId:crypto.randomUUID(),expectedRevision:1,operation:'transaction.save',value:entry(n)}));
    const responses=await Promise.all(bodies.map(b=>f.request('/api/mutate',b)));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const failed=bodies[responses.findIndex(r=>r.status===409)];assert.equal((await f.request('/api/mutate',{...failed,expectedRevision:2})).status,200);
    assert.deepEqual(Object.values(orders(await f.state())).sort(),[1,2,3]);assert.equal((await f.state()).revision,3);
  }finally{f.close();}
});

test('old backups remain supported while invalid or duplicate positive registration orders are rejected',()=>{
  const saved=backup({...emptyData(),transactions:[{...entry(30),notes:'',accountId:null,toAccountId:null,included:true}]});
  for(const version of [1,2])assert.deepEqual(restoreInput({...saved,version}).transactions,saved.data.transactions);
  for(const registrationOrder of [-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1]){
    const bad=structuredClone(saved);bad.data.transactions[0].registrationOrder=registrationOrder;assert.throws(()=>restoreInput(bad),{status:400});
  }
  const duplicate=structuredClone(saved);duplicate.data.transactions[0].registrationOrder=1;duplicate.data.transactions.push({...duplicate.data.transactions[0],id:id(20)});
  assert.throws(()=>restoreInput(duplicate),{status:400});
  for(const row of duplicate.data.transactions)row.registrationOrder=0;assert.equal(restoreInput(duplicate).transactions.length,2);
});
