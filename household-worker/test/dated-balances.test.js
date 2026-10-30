import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,mutateData,assetHistory,backup,restoreInput,snapshotInput,jstDate} from '../src/domain.js';
import {fixture} from './fixture.js';

const account = () => ({id:crypto.randomUUID(),name:'Synthetic bank',type:'bank',items:[{id:crypto.randomUUID(),name:'Deposit',amount:100}]});
const save = (data, row, date, amount) => mutateData(data,'account.save',{...row,asOf:date,items:[{...row.items[0],amount}]});

test('month-end uses each account latest preceding date, carries forward and never uses the following month',()=>{
  const a=account(),b=account();let data=emptyData();
  data=save(data,a,'2026-08-28',100);data=save(data,a,'2026-09-01',900);data=save(data,a,'2026-09-28',200);data=save(data,b,'2026-09-15',-50);
  const points=assetHistory(data,'2026-10-30');
  assert.deepEqual(points.map(p=>p.total),[100,150,150]);
  assert.equal(points[1].accounts[0].asOf,'2026-09-28');
  assert.equal(points[2].provisional,true);assert.equal(points[1].provisional,false);
  assert.equal(data.transactions.length,0);assert.equal(data.snapshots.length,0);
});

test('backdated additions and same-day corrections keep the latest current balance and all other dated records',()=>{
  const a=account();let data=save(emptyData(),a,'2026-09-28',200);
  data=save(data,a,'2026-08-31',100);data=save(data,a,'2026-08-31',110);
  assert.equal(data.accounts[0].items[0].amount,200);
  assert.equal(data.accounts[0].balances.length,2);
  assert.deepEqual(assetHistory(data,'2026-09-30').map(p=>p.total),[110,200]);
  assert.equal(assetHistory(data,'2026-07-31').length,0);
});

test('frozen imported months keep exact totals, legacy metadata is retained, and undated balances are not zero-filled',()=>{
  const a=account();const data=emptyData();
  data.historical=[snapshotInput({month:'2026-08',accounts:[{id:'legacy-bank',name:'Old bank',amount:123}]},true)];
  data.accounts.push({...a,historyId:'legacy-bank'});
  let next=save(data,a,'2026-09-20',200);
  next.accounts.push(account());
  const points=assetHistory(next,'2026-09-30');
  assert.equal(points[0].total,123);assert.equal(points[1].total,null);
  assert.equal(points[1].accounts[0].id,'legacy-bank');assert.equal(points[1].accounts[0].amount,200);
  assert.throws(()=>save(next,{...account(),historyId:'legacy-bank'},'2026-09-20',50),{status:400});
});

test('future/invalid dates, invalid histories and manual asset writes are rejected',()=>{
  const a=account(),data=emptyData();
  for(const date of [undefined,'2026-02-30','2199-01-01'])assert.throws(()=>save(data,a,date,1),{status:400});
  for(const op of ['snapshot.save','snapshot.delete','historical.save','historical.delete'])assert.throws(()=>mutateData(data,op,{}),{status:400});
  const saved=backup(save(data,a,'2026-09-20',100));
  saved.data.accounts[0].balances.push(saved.data.accounts[0].balances[0]);
  assert.throws(()=>restoreInput(saved),{status:400});
});

test('v2 backups round-trip dated records and v1 balances remain explicitly undated',()=>{
  const a=account(),data=save(save(emptyData(),a,'2026-08-31',100),a,'2026-09-30',200);
  const saved=backup(data);assert.equal(saved.version,2);assert.deepEqual(restoreInput(saved),data);
  const old=backup(emptyData());old.version=1;old.data.accounts.push(a);
  const restored=restoreInput(old);assert.equal(restored.accounts[0].balances,undefined);assert.equal(assetHistory(restored).length,0);
});

test('imported current-month assets retain their actual observation date through backup without changing current accounts',()=>{
  const today=jstDate(),data=emptyData();data.accounts.push({...account(),archived:false});
  const before=structuredClone(data.accounts);
  data.historical.push(snapshotInput({month:today.slice(0,7),sourceAsOf:today,accounts:[{id:'legacy-bank',name:'Old bank',amount:123}]},true));
  assert.equal(assetHistory(data)[0].sourceAsOf,today);
  assert.deepEqual(restoreInput(backup(data)),data);assert.deepEqual(data.accounts,before);assert.equal(data.transactions.length,0);
  assert.throws(()=>snapshotInput({month:'2026-08',sourceAsOf:'2026-09-01',accounts:[]},true),{status:400});
});

test('dated updates are atomic under retry and stale revision; viewers cannot write dates',async()=>{
  const f=fixture();try{
    await f.login();const a=(await f.state()).data.accounts[0],body={operation:'account.save',value:{...a,asOf:'2026-09-30'},expectedRevision:0,requestId:crypto.randomUUID()};
    assert.equal((await f.request('/api/mutate',body)).status,200);assert.equal((await f.request('/api/mutate',body)).status,200);
    assert.equal((await f.state()).data.accounts[0].balances.length,1);
    assert.equal((await f.request('/api/mutate',{...body,requestId:crypto.randomUUID()})).status,409);
    const viewer=fixture('viewer');try{await viewer.login();assert.equal((await viewer.mutate('account.save',body.value)).status,403);}finally{viewer.close();}
  }finally{f.close();}
});
