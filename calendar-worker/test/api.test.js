import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {calendarRequest,purgeExpired} from '../src/api.js';
import {CALENDAR_TTL} from '../src/domain.js';

function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(readFileSync(new URL('../migrations/0001_calendar.sql',import.meta.url),'utf8'));
  const prepare=(sql,args=[])=>({bind:(...values)=>prepare(sql,values),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),execute:()=>{const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};},run:async()=>{const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}});
  const sessions=new Map(),registrations=[];
  const env={DB:{prepare,batch:async items=>{db.exec('BEGIN');try{const result=items.map(s=>s.execute());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},PASSKEY_ENABLED:'true',SESSION_SECRET:randomBytes(48).toString('base64url'),SESSION_VERSION:'1',SECURITY:{
    redeemHandoff:async(token,service)=>{if(service!=='calendar'||!['main:one','main:two','second:two'].includes(token))return null;const [account,identity]=token.split(':');return {serviceAccountId:account,identityId:identity,credentialId:'fixture-credential',serviceLinkId:`link-${token}`,sessionEpoch:1};},
    passkeyRollingSession:async input=>{const key=input.sessionIdHash;if(input.action==='register'){registrations.push(input);sessions.set(key,input);return {valid:true,expiresAt:input.expiresAt};}const row=sessions.get(key);if(!row||row.identityId!==input.identityId||row.serviceAccountId!==input.serviceAccountId)return {valid:false};if(input.action==='end'){sessions.delete(key);return {valid:true};}if(input.action==='touch'){assert.equal(input.ttlSeconds,CALENDAR_TTL);row.expiresAt=Math.floor(Date.now()/1000)+input.ttlSeconds;}return {valid:true,expiresAt:row.expiresAt};},
    recordAuditEvent:async()=>({stored:true})
  }};
  async function call(path,{method='GET',cookie='',body,foreground=false,origin='https://calendar.test'}={}){const r=await calendarRequest(new Request(`https://calendar.test/calendar/api/${path}`,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(foreground?{'X-Troom-Activity':'foreground'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};}
  async function login(token='main:one'){const r=await call('passkey/handoff',{method:'POST',body:{handoffToken:token}});assert.equal(r.status,200);return r.cookie;}
  async function mutate(cookie,kind,payload,expectedVersion=0,requestId=randomUUID()){return call('mutations',{method:'POST',cookie,body:{kind,id:kind==='settings'?'preferences':payload.id,payload,expectedVersion,requestId}});}
  return {db,env,call,login,mutate,registrations};
}
const named=(name='佐藤と遊ぶ')=>({id:randomUUID(),name,archived:false,mergedInto:null,targetDays:null});
const event=(ids=[])=>({id:randomUUID(),title:'食事',start:'2026-10-29T18:00',end:'2026-10-29T19:00',allDay:false,trackIds:ids,tagIds:[],color:'blue',place:'',memo:'',url:'',cancelled:false,deletedAt:null,repeat:{mode:'NONE',interval:1,weekdays:[],monthly:'DAY',until:null,count:null,dates:[]},exceptions:{},excludedDates:[]});
const settings=()=>({theme:'blue',startPage:'MONTH',durationMinutes:60,reminders:[],eventReminders:{},pinned:[],manualOrder:[],sort:'MANUAL',descending:false,cacheMiB:100});

test('explicit linked accounts isolate events while the same account shares events and keeps Identity settings private',async()=>{
  const f=fixture(),one=await f.login(),two=await f.login('main:two'),other=await f.login('second:two');
  const track=named();assert.equal((await f.mutate(one,'track',track)).status,200);
  assert.equal((await f.mutate(one,'event',event([track.id]))).status,200);assert.equal((await f.mutate(one,'event',event())).status,200);
  assert.equal((await f.mutate(one,'settings',settings())).status,200);
  const own=await f.call('sync',{cookie:one}),same=await f.call('sync',{cookie:two}),separate=await f.call('sync',{cookie:other});
  assert.equal(own.body.entities.length,4);assert.equal(same.body.entities.length,3);assert.equal(separate.body.entities.length,0);
  assert.equal((await f.mutate(other,'event',event([track.id]))).status,400);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('retry is idempotent and stale writes return current version without losing the accepted edit',async()=>{
  const f=fixture(),cookie=await f.login(),e=event(),requestId=randomUUID();
  const saved=await f.mutate(cookie,'event',e,0,requestId);assert.equal(saved.status,200);assert.equal(saved.body.entity.version,1);
  assert.deepEqual((await f.mutate(cookie,'event',e,0,requestId)).body,saved.body);
  assert.equal((await f.mutate(cookie,'event',{...e,title:'別の再送'},0,requestId)).status,409);
  assert.equal((await f.mutate(cookie,'event',{...e,title:'更新'},1)).status,200);
  const stale=await f.mutate(cookie,'event',{...e,title:'オフライン変更'},1);assert.equal(stale.status,409);assert.equal(stale.body.current.payload.title,'更新');assert.equal(stale.body.current.version,2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM calendar_requests').get().n,2);
});
test('deleted records purge after 30 days and stale offline data cannot resurrect a purged event',async()=>{
  const f=fixture(),cookie=await f.login(),old={...event(),deletedAt:Date.now()-31*86400000},recent={...event(),deletedAt:Date.now()-29*86400000};
  assert.equal((await f.mutate(cookie,'event',old)).status,200);await f.mutate(cookie,'event',recent);await purgeExpired(f.env);
  const rows=(await f.call('sync',{cookie})).body.entities;assert.equal(rows.find(e=>e.id===old.id).purged,true);assert.equal(rows.find(e=>e.id===recent.id).purged,false);
  assert.equal((await f.mutate(cookie,'event',{...old,deletedAt:null},2)).status,409);
});
test('renames preserve tracking membership, concurrent duplicate names alias safely, merge cycles are rejected',async()=>{
  const f=fixture(),cookie=await f.login(),first=named(),duplicate=named();await f.mutate(cookie,'track',first);
  const aliased=await f.mutate(cookie,'track',duplicate);assert.equal(aliased.body.entity.payload.mergedInto,first.id);
  assert.equal((await f.mutate(cookie,'track',{...first,name:'友達と会う'},1)).status,200);
  assert.equal((await f.mutate(cookie,'track',{...first,mergedInto:duplicate.id},2)).status,400);
});
test('30-day rolling lifetime, revocation, logout and origin guards fail closed',async()=>{
  const f=fixture(),cookie=await f.login();assert.equal(f.registrations[0].service,'calendar');assert.ok(Math.abs(f.registrations[0].expiresAt-Math.floor(Date.now()/1000)-CALENDAR_TTL)<=1);
  assert.equal((await f.call('session',{cookie})).status,200);assert.equal((await f.call('session',{cookie:cookie+'tamper'})).status,401);
  assert.equal((await f.call('mutations',{method:'POST',cookie,origin:'https://evil.test',body:{}})).status,403);
  assert.equal((await f.call('logout',{method:'POST',cookie,body:{}})).status,200);assert.equal((await f.call('sync',{cookie})).status,401);
  const next=await f.login();f.env.PASSKEY_ENABLED='false';assert.equal((await f.call('session',{cookie:next})).status,401);
});
test('strict validation rejects invalid dates, missing end times, unknown fields and recursive exceptions',async()=>{
  const f=fixture(),cookie=await f.login();for(const payload of [{...event(),end:'2026-10-29T17:00'},{...event(),start:'2026-02-30T18:00'},{...event(),photo:'not-supported'},{...event(),allDay:true}])assert.equal((await f.mutate(cookie,'event',payload)).status,400);
});
test('splitting a series saves all changes atomically and retries the complete group once',async()=>{
  const f=fixture(),cookie=await f.login(),old=event(),next=event();await f.mutate(cookie,'event',old);
  const group={kind:'batch',id:randomUUID(),expectedVersion:0,requestId:randomUUID(),payload:{operations:[{kind:'event',id:next.id,expectedVersion:0,payload:next},{kind:'event',id:old.id,expectedVersion:0,payload:{...old,title:'stale'}}]}};
  let result=await f.call('mutations',{method:'POST',cookie,body:group});assert.equal(result.status,409);assert.equal(f.db.prepare('SELECT count(*) AS n FROM calendar_entities').get().n,1);
  group.payload.operations[1].expectedVersion=1;result=await f.call('mutations',{method:'POST',cookie,body:group});assert.equal(result.status,200);assert.equal(result.body.entities.length,2);
  assert.deepEqual((await f.call('mutations',{method:'POST',cookie,body:group})).body,result.body);assert.equal(f.db.prepare('SELECT count(*) AS n FROM calendar_entities').get().n,2);
});
test('per-occurrence trash expires without removing other exceptions or resurrecting old data',async()=>{
  const f=fixture(),cookie=await f.login(),e=event();e.repeat.mode='MONTHLY';e.exceptions={'2026-08-29':{deleted:true,deletedAt:Date.now()-31*86400000,replacement:{...e,title:'deleted private edit',repeat:{...e.repeat,mode:'NONE'}}},'2026-09-29':{cancelled:true},'2026-10-29':{deleted:true,deletedAt:Date.now()-2*86400000}};
  assert.equal((await f.mutate(cookie,'event',e)).status,200);
  assert.equal((await f.mutate(cookie,'event',{...e,exceptions:{}},1)).status,409);
  await purgeExpired(f.env);const current=(await f.call('sync',{cookie})).body.entities[0];
  assert.deepEqual(current.payload.exceptions['2026-08-29'],{deleted:true});assert.equal(current.payload.exceptions['2026-09-29'].cancelled,true);assert.ok(current.payload.exceptions['2026-10-29'].deletedAt);
});
test('large sync pages remain bounded and keep a cursor for the remaining rows',async()=>{
  const f=fixture(),cookie=await f.login();for(let i=0;i<9;i++){const e=event();e.memo='x'.repeat(900000);f.db.prepare("INSERT INTO calendar_entities(account_id,owner_identity,kind,id,payload,version) VALUES('main','','event',?,?,1)").run(e.id,JSON.stringify(e));}
  const first=await f.call('sync',{cookie});assert.equal(first.status,200);assert.ok(first.body.more);assert.ok(first.body.entities.length<9);
  const next=await f.call(`sync?cursor=${first.body.cursor}`,{cookie});assert.equal(first.body.entities.length+next.body.entities.length,9);assert.equal(next.body.more,false);
});
