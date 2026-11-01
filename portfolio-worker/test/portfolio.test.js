import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixture.js';
import imported from '../seed/report.mjs';
import current from '../../asset-report-k7m4q9x2/data/portfolio-data.mjs';
import { seedStatements } from '../tools/seed.mjs';

test('initial import retains the latest source, every historical date and original accounting', () => {
  assert.deepEqual(imported, current);
  const statements = seedStatements();
  assert.equal(statements.length, current.history.length + 1);
  assert.equal(JSON.parse(statements[0].params[0]).basePrincipal, current.basePrincipal);
  assert.equal(statements.filter(s => s.params[2] !== null).length, 2, 'metadata plus latest breakdown only; no invented history');
});
test('public shell contains no financial data; protected APIs reject anonymous users, wrong contexts, revoked credentials and viewer writes', async () => {
  const f=fixture(),v=fixture('viewer');
  try {
    assert.equal((await f.request('/')).status,200);
    assert.equal((await f.request('/api/data')).status,401);
    await f.login(); await v.login();
    assert.equal((await f.request('/api/data',undefined,{'X-Portfolio-Session':'wrong'})).status,401);
    const record=(await v.state()).record;
    assert.equal((await v.save(record)).status,403);
    assert.equal((await f.save(record)).status,200);
    f.setActive(false); assert.equal((await f.request('/api/data')).status,401);
  } finally {f.close();v.close();}
});
test('save recalculates totals and chart, allows past insertion and same-day correction without changing later records', async () => {
  const f=fixture();
  try {
    await f.login(); const original=await f.state();
    const record={...original.record,period:'2026-10-29',time:'14:35',assets:original.record.assets.map(a=>({...a,marketValue:400000}))};
    assert.equal((await f.save(record)).status,200);
    let state=await f.state(); assert.equal(state.history[0].period,record.period); assert.equal(state.history[0].rawMarketValue,1600000);
    assert.deepEqual(state.record,original.record,'backdated save must preserve the latest holdings');
    record.assets[0].marketValue=500000; assert.equal((await f.save(record)).status,200);
    state=await f.state(); assert.equal(state.history.length,3); assert.equal(state.history[0].rawMarketValue,1700000);
    const saved=(await (await f.request('/api/record?period=2026-10-29')).json()).record; assert.equal(saved.time,'14:35');
    const next={...record,period:'2026-11-01'}; assert.equal((await f.save(next)).status,200);
    state=await f.state(); assert.equal(state.report.summary.marketValue,1668000);assert.equal(state.report.summary.profit,668000);assert.equal(state.report.summary.returnRate,66.8);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM portfolio_changes').get().n,3);
  } finally {f.close();}
});
test('legacy total-only corrections do not fabricate stock holdings', async()=>{
 const f=fixture();try{await f.login();const before=await f.state(),old=(await (await f.request('/api/record?period=2026-10-30')).json()).record;
 assert.equal(old.assets,null);assert.equal((await f.save({...old,rawMarketValue:1234567})).status,200);const after=await f.state();assert.equal(after.history[0].rawMarketValue,1234567);assert.deepEqual(after.record,before.record);
 assert.equal((await f.save({...old,period:'2026-10-28'})).status,400);
 }finally{f.close();}
});
test('atomic revision control, idempotent retry, invalid dates and CSRF protect saved records',async()=>{
 const f=fixture();try{await f.login();const initial=await f.state(),record=initial.record,requestId=crypto.randomUUID();
 assert.equal((await f.save(record,{requestId,expectedRevision:0})).status,200);
 assert.equal((await f.save(record,{requestId,expectedRevision:0})).status,200);
 assert.equal((await f.save({...record,time:'12:30'},{requestId,expectedRevision:0})).status,409);
 assert.equal((await f.save(record,{expectedRevision:0})).status,409);
 for(const invalid of [{...record,period:'2026-02-30'},{...record,time:'25:00'},{...record,assets:[{...record.assets[0],marketValue:-1}]}])assert.equal((await f.save(invalid)).status,400);
 assert.equal((await f.request('/api/save',{requestId:crypto.randomUUID(),expectedRevision:1,record},{Origin:'https://evil.test'})).status,403);
 const snapshot=await f.state();assert.equal(snapshot.revision,1);
 const answers=await Promise.all([f.save({...record,time:'01:00'},{expectedRevision:1}),f.save({...record,time:'02:00'},{expectedRevision:1})]);assert.deepEqual(answers.map(r=>r.status).sort(),[200,409]);assert.equal((await f.state()).revision,2);
 }finally{f.close();}
});
