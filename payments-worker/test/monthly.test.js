import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { allocation, allocationPrefix, paymentView, monthlyView, dashboard, currentJstMonth, monthText, month } from '../src/domain.js';
import { fixture } from './fixture.js';
const input = extra => ({paidOn:'2020-01-01',payee:'Synthetic',amount:10000,startMonth:'2020-01',months:12,...extra});
async function create(f,extra={}) { const id=crypto.randomUUID(); assert.equal((await f.request('/api/entries',{...input(extra),requestId:id})).status,200); return id; }
const mark = (f,id,version,target='2020-01',completed=true,requestId=crypto.randomUUID()) => f.request(`/api/entries/${id}/months/${target}`,{requestId,expectedVersion:version,completed},{},'PUT');
test('integer allocation: remainder first, amount smaller than months, maximum input, exact sums', () => {
  assert.deepEqual(Array.from({length:12},(_,i)=>allocation(10000,12,i)),[834,834,834,834,833,833,833,833,833,833,833,833]);
  assert.deepEqual(Array.from({length:12},(_,i)=>allocation(3,12,i)),[1,1,1,0,0,0,0,0,0,0,0,0]);
  for (const total of [1,3,10000,999999999999]) for (const count of [1,3,12,1200]) {
    let sum=0;
    for(let i=0;i<count;i++) { const amount=allocation(total,count,i); assert(Number.isInteger(amount)); sum+=amount; assert.equal(sum,allocationPrefix(total,count,i+1)); }
    assert.equal(sum,total);
  }
});
test('year rollover and JST month boundaries preserve missed counts; completion alone reduces remaining', () => {
  const row={amount:10000,start_month:'2025-12',months:3};
  assert.equal(currentJstMonth(new Date('2025-12-31T14:59:59.999Z')),'2025-12');
  assert.equal(currentJstMonth(new Date('2025-12-31T15:00:00Z')),'2026-01');
  const view=paymentView(row,'2026-04'); assert.equal(view.remaining_count,3); assert.equal(view.past_pending_count,3); assert.equal(view.past_pending_amount,10000); assert.equal(view.status,'pending');
  assert.equal(paymentView({...row,completed_count:3,past_completed_count:3,past_completed_amount:10000},'2026-04').status,'completed');
  assert.deepEqual(monthlyView(row,[],'2026-01').map(m=>[m.target_month,m.amount,m.can_complete]),[['2025-12',3334,true],['2026-01',3333,true],['2026-02',3333,false]]);
  assert.equal(dashboard([view]).past_pending_amount,'10000');
});
test('mark/undo retries, explicit desired state, immutable audit and completed edit/delete guards', async () => {
  const f=fixture(); try {
    await f.login(); const id=await create(f), req=crypto.randomUUID();
    assert.equal((await mark(f,id,1,'2020-01',true,req)).status,200);
    assert.equal((await mark(f,id,1,'2020-01',true,req)).status,200);
    assert.equal((await mark(f,id,1,'2020-01',false,req)).status,409);
    assert.equal((await mark(f,id,1)).status,409);
    assert.equal((await mark(f,id,2)).status,200); // already complete is a no-op
    assert.equal(f.sqlite.prepare('SELECT version FROM payments_entries').get().version,2);
    let entry=(await (await f.request('/api/entries')).json()).entries[0];
    assert.equal(entry.remaining_count,11); assert.equal(entry.past_pending_count,11); assert.equal(entry.past_pending_amount,9166);
    const details=await (await f.request(`/api/entries/${id}/months`)).json(); assert(details.months[0].completed_at.endsWith('Z')); assert.equal(details.months[1].completed_at,null);
    for (const extra of [{amount:1},{months:1},{startMonth:'2020-02'}]) assert.equal((await f.request(`/api/entries/${id}`,{...input(extra),requestId:crypto.randomUUID(),expectedVersion:2},{},'PUT')).status,409);
    assert.equal((await f.request(`/api/entries/${id}`,{requestId:crypto.randomUUID(),expectedVersion:2},{},'DELETE')).status,409);
    assert.equal((await f.request(`/api/entries/${id}`,{...input({payee:'Renamed'}),requestId:crypto.randomUUID(),expectedVersion:2},{},'PUT')).status,200);
    const undo=crypto.randomUUID(); assert.equal((await mark(f,id,3,'2020-01',false,undo)).status,200); assert.equal((await mark(f,id,3,'2020-01',false,undo)).status,200);
    assert.equal((await f.request(`/api/entries/${id}`,{...input({amount:3}),requestId:crypto.randomUUID(),expectedVersion:4},{},'PUT')).status,200);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_monthly_marks').get().n,0);
    assert.equal((await mark(f,id,5)).status,200); assert.equal(f.sqlite.prepare('SELECT amount FROM payments_monthly_marks').get().amount,1);
    assert.equal((await mark(f,id,6,'2020-01',false)).status,200);
    assert.equal((await f.request(`/api/entries/${id}`,{requestId:crypto.randomUUID(),expectedVersion:7},{},'DELETE')).status,200);
    assert.equal((await mark(f,id,8)).status,404);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payments_operation_audit WHERE action='month_complete'").get().n,2);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM payments_operation_audit WHERE action='allocation_change'").get().n,1);
    assert.throws(()=>f.sqlite.exec('DELETE FROM payments_operation_audit'),/immutable/);
    assert.throws(()=>f.sqlite.exec("UPDATE payments_operation_audit SET identity_id='primary-admin'"),/immutable/);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { f.close(); }
});
test('current dashboard uses actual amounts, zero-yen months can be completed, future/outside months rejected', async () => {
  const f=fixture(); try {
    await f.login(); const current=currentJstMonth(),start=monthText(month(current)-2), id=await create(f,{amount:1,startMonth:start,months:4});
    let data=await (await f.request('/api/entries')).json(); assert.equal(data.dashboard.current_pending_amount,'0'); assert.equal(data.dashboard.past_pending_amount,'1'); assert.equal(data.dashboard.past_pending_count,2);
    assert.equal((await mark(f,id,1,current)).status,200);
    data=await (await f.request('/api/entries')).json(); assert.equal(data.dashboard.current_completed_count,1); assert.equal(data.entries[0].remaining_count,3);
    for (const target of [monthText(month(current)+1),monthText(month(start)-1),monthText(month(start)+4)]) assert.equal((await mark(f,id,2,target)).status,400);
    assert.equal((await mark(f,id,2,start)).status,200);
    assert.equal((await mark(f,id,3,monthText(month(start)+1))).status,200);
    data=await (await f.request('/api/entries')).json(); assert.equal(data.dashboard.past_pending_count,0); assert.equal(data.entries[0].remaining_count,1);
    // Database also rejects bypassing allocation/future validation.
    assert.throws(()=>f.sqlite.prepare('INSERT INTO payments_monthly_marks VALUES (?,?,?,?)').run(id,monthText(month(current)+1),0,new Date().toISOString()),/invalid_month/);
  } finally { f.close(); }
});
test('concurrent tabs: one transaction wins; opposing mark, edit and delete cannot overwrite it', async () => {
  for (const rival of ['mark','edit','delete']) {
    const f=fixture(); try {
      await f.login(); const id=await create(f); const batch=f.env.DB.batch.bind(f.env.DB); let arrivals=0, release;
      const gate=new Promise(resolve=>release=resolve);
      f.env.DB.batch=async statements=>{ if(++arrivals===2) release(); await gate; return batch(statements); };
      const a=mark(f,id,1);
      const b=rival==='mark' ? mark(f,id,1,'2020-02') : f.request(`/api/entries/${id}`,{...(rival==='edit'?input({amount:20}):{}),expectedVersion:1,requestId:crypto.randomUUID()},{},rival==='edit'?'PUT':'DELETE');
      assert.deepEqual((await Promise.all([a,b])).map(r=>r.status).sort(),[200,409]);
      assert.equal(f.sqlite.prepare('SELECT version FROM payments_entries').get().version,2);
      assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM payments_operation_audit').get().n,2);
    } finally {f.close();}
  }
});
test('simultaneous duplicate operation IDs return success with exactly one state transition and audit',async()=>{
  const f=fixture(); try {
    await f.login(); const id=await create(f), requestId=crypto.randomUUID(), batch=f.env.DB.batch.bind(f.env.DB);
    let arrivals=0,release; const gate=new Promise(resolve=>release=resolve);
    f.env.DB.batch=async statements=>{if(++arrivals===2)release();await gate;return batch(statements);};
    const result=await Promise.all([mark(f,id,1,'2020-01',true,requestId),mark(f,id,1,'2020-01',true,requestId)]);
    assert.deepEqual(result.map(r=>r.status),[200,200]);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_monthly_marks').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_operation_audit').get().n,2);
  } finally {f.close();}
});
test('audit failure rolls back entry, mark, delete and idempotency key; retry succeeds once', async () => {
  const f=fixture(); try {
    await f.login(); const id=await create(f), key=crypto.randomUUID();
    f.sqlite.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON payments_operation_audit BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
    assert.equal((await mark(f,id,1,'2020-01',true,key)).status,503);
    assert.equal((await f.request(`/api/entries/${id}`,{...input({amount:5}),requestId:crypto.randomUUID(),expectedVersion:1},{},'PUT')).status,503);
    assert.equal((await f.request(`/api/entries/${id}`,{requestId:crypto.randomUUID(),expectedVersion:1},{},'DELETE')).status,503);
    assert.equal((await f.request('/api/entries',{...input(),requestId:crypto.randomUUID()})).status,503);
    assert.equal(f.sqlite.prepare('SELECT version FROM payments_entries').get().version,1);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_requests').get().n,1); assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_monthly_marks').get().n,0);
    f.sqlite.exec('DROP TRIGGER synthetic_audit_failure'); assert.equal((await mark(f,id,1,'2020-01',true,key)).status,200);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM payments_operation_audit').get().n,2);
  } finally {f.close();}
});
test('additive migration preserves all existing data and creates no inferred completions',()=>{
  const db=new DatabaseSync(':memory:'); try {
    db.exec(readFileSync(new URL('../migrations/0001_payments.sql',import.meta.url),'utf8'));
    db.exec("INSERT INTO payments_accounts VALUES ('owner','Synthetic',1,3); INSERT INTO payments_entries VALUES ('old','owner','2020-01-01','Synthetic','',1,'2020-01',12,'',1,'2020','2020',NULL); INSERT INTO payments_requests VALUES ('old','hash','{}','2020')");
    const tables=['payments_accounts','payments_entries','payments_requests'], before=tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all());
    db.exec(readFileSync(new URL('../migrations/0002_monthly_ledger.sql',import.meta.url),'utf8'));
    assert.deepEqual(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()),before);
    assert.equal(db.prepare('SELECT count(*) n FROM payments_monthly_marks').get().n,0);
  } finally {db.close();}
});
test('monthly APIs retain session, CSRF, no-store, CSP and revocation boundaries',async()=>{
  const f=fixture(); try {
    await f.login(); const id=await create(f), path=`/api/entries/${id}/months/2020-01`, body={requestId:crypto.randomUUID(),expectedVersion:1,completed:true};
    assert.equal((await f.request(path,body,{Origin:'https://foreign.test'},'PUT')).status,403);
    assert.equal((await f.request(path,body,{'Content-Type':'text/plain'},'PUT')).status,403);
    assert.equal((await f.request(path,{...body,completed:'true'},{},'PUT')).status,400);
    const response=await f.request(`/api/entries/${id}/months`); assert.equal(response.headers.get('cache-control'),'no-store'); assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    f.setActive(false); assert.equal((await f.request(path,body,{},'PUT')).status,401); assert.equal((await f.request(`/api/entries/${id}/months`)).status,401);
  } finally {f.close();}
});
test('large ledger: 2000 entries and 120000 marks stay indexed with bounded list payload',async()=>{
  const f=fixture(); try {
    await f.login(); const insert=f.sqlite.prepare("INSERT INTO payments_entries VALUES (?,'owner','2020-01-01','Synthetic','',10000,'2020-01',1200,'',1,'2020','2020',NULL)"), m=f.sqlite.prepare('INSERT INTO payments_monthly_marks VALUES (?,?,?,?)');
    f.sqlite.exec('BEGIN'); for(let i=0;i<2000;i++){const id=crypto.randomUUID();insert.run(id); for(let j=0;j<60;j++)m.run(id,monthText(month('2020-01')+j),allocation(10000,1200,j),'2025-01-01T00:00:00Z');} f.sqlite.exec('COMMIT');
    const started=performance.now(), response=await f.request('/api/entries'), result=await response.json();
    assert.equal(result.entries.length,2000); assert.equal(result.dashboard.completed_count,120000); assert.equal(result.entries[0].remaining_count,1140);
    assert(performance.now()-started<5000); assert(JSON.stringify(result).length<2500000);
    const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM payments_monthly_marks WHERE entry_id=? AND completed_at IS NOT NULL').all('x'); assert(plan.some(r=>r.detail.includes('payments_marks_completed')));
    console.log(`Synthetic scale: 2000 entries / 120000 marks, list ${Math.round(performance.now()-started)}ms, ${JSON.stringify(result).length} bytes`);
  } finally {f.close();}
});
