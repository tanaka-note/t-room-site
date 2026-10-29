import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,household} from './fixture.js';
import {backup,csv,defaultCategories,emptyData,mutateData,restoreInput,date} from '../src/domain.js';
const id=()=>crypto.randomUUID();
function entry(data,extra={}){return {id:id(),date:'2026-09-15',type:'expense',amount:1234,description:'Sample shop',notes:'',accountId:data.accounts[0]?.id||null,categoryId:data.categories.find(c=>c.type==='expense').id,included:true,...extra};}
test('zero start and independent income, account balances and month-end snapshots',async()=>{const f=fixture();try{
  await f.login();let s=await f.state();assert.equal(s.revision,0);assert.equal(s.data.accounts[0].name,'減価償却');assert.equal(s.data.accounts[0].items[0].amount,0);assert.equal(s.data.transactions.length,0);assert.equal(s.data.historical.length,0);
  assert.equal((await f.mutate('transaction.save',entry(s.data))).status,200);s=await f.state();assert.equal(s.data.accounts[0].items[0].amount,0);
  const account=structuredClone(s.data.accounts[0]);account.items[0].amount=-100000;assert.equal((await f.mutate('account.save',account)).status,200);s=await f.state();assert.equal(s.data.transactions.length,1);assert.equal(s.data.transactions[0].amount,1234);
  assert.equal((await f.mutate('snapshot.save',{month:'2026-09',accounts:[{id:account.id,name:account.name,amount:-90000}]})).status,200);s=await f.state();assert.equal(s.data.snapshots[0].total,-90000);assert.equal(s.data.accounts[0].items[0].amount,-100000);assert.equal(s.data.transactions.length,1);
  assert.equal((await f.mutate('historical.save',{month:'2020-01',accounts:[{id:'old-account',name:'Sample previous account',amount:50000}]})).status,200);s=await f.state();assert.equal(s.data.accounts[0].items[0].amount,-100000);assert.equal(s.data.transactions.length,1);
}finally{f.close();}});
test('viewer can read all records and export but cannot mutate or restore',async()=>{const f=fixture('viewer');try{
  await f.login();const s=await f.state();assert.equal((await f.request('/api/session')).status,200);assert.equal((await f.request('/api/backup')).status,200);assert.equal((await f.request('/api/export.csv')).status,200);
  for(const operation of ['transaction.save','account.save','snapshot.save','historical.save','category.save'])assert.equal((await f.mutate(operation,entry(s.data))).status,403);
  assert.equal((await f.request('/api/restore',{requestId:id(),expectedRevision:0,backup:backup(s.data)})).status,403);assert.equal((await f.state()).revision,0);
}finally{f.close();}});
test('single-use handoff, cookie signature, expiry, role, revocation, logout and CSRF fail closed',async()=>{const f=fixture();try{
  assert.equal((await f.request('/api/data')).status,401);await f.login();const cookie=f.cookie;assert.equal((await f.request('/api/passkey/handoff',{handoffToken:'fixture-handoff'})).status,401);
  assert.equal((await f.mutate('category.delete',{id:id()},{requestId:id()})).status,200);
  assert.equal((await f.request('/api/mutate',{}, {Origin:'https://attacker.test'})).status,403);
  assert.equal((await f.request('/api/mutate',{}, {'Content-Type':'text/plain'})).status,403);
  f.cookie=cookie+'x';assert.equal((await f.request('/api/data')).status,401);f.cookie=cookie;
  const payload=JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0],'base64url'));payload.role='viewer';f.cookie='troom_household_session='+await household.signSession(payload,f.env);assert.equal((await f.request('/api/data')).status,401);
  payload.role='owner';payload.expiresAt=0;f.cookie='troom_household_session='+await household.signSession(payload,f.env);assert.equal((await f.request('/api/data')).status,401);
  f.cookie=cookie;f.setActive(false);assert.equal((await f.request('/api/data')).status,401);f.setActive(true);assert.equal((await f.request('/api/logout',{})).status,200);f.cookie=cookie;assert.equal((await f.request('/api/data')).status,401);
}finally{f.close();}});
test('account provider exposes two scoped roles and rejects owner handoff from another Identity',async()=>{const f=fixture('owner','other-person');try{
  assert.equal((await f.request('/api/passkey/handoff',{handoffToken:'fixture-handoff'})).status,401);
  const provider=new household.SecurityIntegration({},f.env),targets=(await provider.listLinkTargets()).targets;assert.equal(targets.length,2);assert.equal(targets.find(t=>t.role==='viewer').shared,true);assert.equal(targets.find(t=>t.role==='owner').privileged,true);assert.equal((await provider.describeAccount({accountId:'viewer',rootFolderId:7})).valid,false);assert.equal((await provider.describeAccount({accountId:'unknown'})).valid,false);
}finally{f.close();}});
test('retries are idempotent and concurrent stale updates cannot partially commit',async()=>{const f=fixture();try{
  await f.login();const s=await f.state(),requestId=id(),value=entry(s.data),body={requestId,expectedRevision:0,operation:'transaction.save',value};assert.equal((await f.request('/api/mutate',body)).status,200);assert.equal((await f.request('/api/mutate',body)).status,200);assert.equal((await f.state()).data.transactions.length,1);
  assert.equal((await f.request('/api/mutate',{...body,value:{...value,amount:99}})).status,409);
  const make=()=>f.request('/api/mutate',{requestId:id(),expectedRevision:1,operation:'transaction.save',value:entry(s.data)});const results=await Promise.all([make(),make()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await f.state()).data.transactions.length,2);assert.equal((await f.state()).revision,2);
}finally{f.close();}});
test('backup is validated, restores all data atomically, and does not import accounts or privileges',async()=>{const f=fixture();try{
  await f.login();const s=await f.state();await f.mutate('transaction.save',entry(s.data));const saved=await (await f.request('/api/backup')).json();saved.data.accounts[0].items[0].amount=-3000;
  const bad=structuredClone(saved);bad.data.transactions[0].accountId=id();assert.equal((await f.request('/api/restore',{requestId:id(),expectedRevision:1,backup:bad})).status,400);assert.equal((await f.state()).revision,1);
  const original=f.env.DB.batch;let count=0;f.env.DB.batch=async statements=>{if(++count===2)throw new Error('synthetic stage failure');return original.call(f.env.DB,statements);};assert.equal((await f.request('/api/restore',{requestId:id(),expectedRevision:1,backup:saved})).status,503);assert.equal((await f.state()).data.accounts[0].items[0].amount,0);f.env.DB.batch=original;
  saved.serviceAccounts=[{role:'owner',id:'evil'}];const requestId=id(),body={requestId,expectedRevision:1,backup:saved};assert.equal((await f.request('/api/restore',body)).status,200);assert.equal((await f.request('/api/restore',body)).status,200);assert.equal((await f.state()).data.accounts[0].items[0].amount,-3000);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM household_accounts').get().n,2);
}finally{f.close();}});
test('concurrent restore attempts cannot overwrite the winning generation',async()=>{const f=fixture();try{
  await f.login();const saved=backup((await f.state()).data);const a=structuredClone(saved),b=structuredClone(saved);a.data.accounts[0].items[0].amount=111;b.data.accounts[0].items[0].amount=222;const requestId=id();const results=await Promise.all([f.request('/api/restore',{requestId,expectedRevision:0,backup:a}),f.request('/api/restore',{requestId,expectedRevision:0,backup:b})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const winning=results[0].status===200?111:222;assert.equal((await f.state()).data.accounts[0].items[0].amount,winning);
}finally{f.close();}});
test('validation rejects broken dates, monetary precision, foreign references and modified builtins',()=>{
  for(const value of ['2026-02-30','2026-99-99','not-a-date'])assert.throws(()=>date(value),{status:400});const data=emptyData();const v=entry(data);assert.throws(()=>mutateData(data,'transaction.save',{...v,amount:1.5}),{status:400});assert.throws(()=>mutateData(data,'transaction.save',{...v,accountId:id()}),{status:400});assert.throws(()=>mutateData(data,'snapshot.save',{month:'2199-12',accounts:[]}),{status:400});const value=backup(data);value.data.categories[0].name='changed';assert.throws(()=>restoreInput(value),{status:400});
});
test('CSV preserves signed numeric amounts and neutralizes spreadsheet formulas in text',()=>{
  const data=emptyData();data.transactions.push(entry(data,{description:'=HYPERLINK("https://invalid.test")',amount:1234}));const value=csv(data);assert.match(value,/"-1234"/);assert.match(value,/'=HYPERLINK/);assert.ok(value.startsWith('\ufeff'));assert.equal(restoreInput(backup(emptyData())).categories.length,defaultCategories().length);
});
