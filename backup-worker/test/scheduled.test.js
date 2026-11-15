import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {SERVICES} from '../src/registry.js';
import {backupService,capture,compress,digest} from '../src/backup.js';
import {getBackupSnapshot} from '../src/browser.js';
import {database,d1,Bucket} from './fixtures.mjs';
import {dispatchServices} from '../src/dispatch.js';

const ids=Object.keys(SERVICES);
const scheduledTime=Date.now();
// Execute the actual entrypoint; only the Workers-only RPC base class and its
// imports are supplied by the fixture. The scheduled handler is never replaced.
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
 .replace(/^import .*;\r?\n/gm,'')
 .replace(/^export \{.*;\r?\n/gm,'')
 .replace('export class BackupBrowserIntegration','class BackupBrowserIntegration')
 .replace('export default {','globalThis.worker = {');
function harness(backup) {
 const info=[],errors=[],calls=[];
 const context={WorkerEntrypoint:class{},SERVICES,crypto,getBackupSnapshot,dispatchServices,
  console:{log:value=>info.push(value),error:value=>errors.push(value)},
  backupService:async(env,id,now)=>{calls.push(id);return backup(env,id,now);}};
 vm.runInNewContext(source,context);
 return {info,errors,calls,run:env=>context.worker.scheduled({scheduledTime},env),
  summary:()=>[...info,...errors].map(line=>JSON.parse(line)).find(event=>event.event==='backup_run_finished')};
}
const incomplete=error=>error.name==='BackupRunError'&&error.message==='Backup run incomplete';
test('actual Cron uses Workflow dispatch without running legacy captures when the binding exists',async t=>{
 t.mock.method(console,'log',()=>{});
 const h=harness(async()=>{throw new Error('legacy path');}),created=[];
 await h.run({D1_BACKUPS:{async create(job){created.push(job.params.service);}}});
 assert.deepEqual(created,ids);assert.deepEqual(h.calls,[]);assert.equal(h.summary(),undefined);
});
function checkSummary(h,expected) {
 assert.deepEqual(h.calls,ids,'every service must be attempted before the invocation finishes');
 const summary=h.summary();
 assert.match(summary.runId,/^[0-9a-f-]{36}$/);
 assert.equal(summary.scheduledTime,scheduledTime);
 assert.equal(summary.total,ids.length);
 assert.equal(summary.state,expected);
 assert.equal(Object.values(summary.counts).reduce((sum,count)=>sum+count,0),ids.length);
 return summary;
}

test('scheduled succeeds only after all configured services return ok',async()=>{
 const h=harness(async()=>({state:'ok',sha256:'not-logged',payload:'secret-fixture'}));
 await h.run({});
 const summary=checkSummary(h,'ok');
 assert.equal(summary.counts.ok,ids.length);
 assert.equal(h.info.length,1);assert.equal(h.errors.length,0);
 assert.doesNotMatch(JSON.stringify(summary),/not-logged|secret-fixture|sha256|payload/);
});
for(const state of ['failed','audit_unavailable','prune_failed']) {
 test(`scheduled rejects ${state} after continuing all remaining services`,async()=>{
  const h=harness(async(_env,id)=>({state:id===ids[0]?state:'ok'}));
  await assert.rejects(h.run({}),incomplete);
  const summary=checkSummary(h,'failed');
  assert.equal(summary.counts[state],1);assert.equal(summary.counts.ok,ids.length-1);
  assert.equal(h.errors.length,1);assert.equal(h.info.length,0);
 });
}
for(const result of [undefined,null,{}, {state:'secret-fixture-state'}, {state:'ok',get ignored(){throw new Error('must not read');}}]) {
 const valid=result?.state==='ok';
 test(`scheduled handles ${valid?'an ok result without inspecting other fields':'an invalid result '+JSON.stringify(result)}`,async()=>{
  const h=harness(async(_env,id)=>id===ids[0]?result:{state:'ok'});
  if(valid)await h.run({});else await assert.rejects(h.run({}),incomplete);
  const summary=checkSummary(h,valid?'ok':'failed');
  assert.equal(summary.counts.invalid_result,valid?0:1);
  assert.doesNotMatch(JSON.stringify(summary),/secret-fixture-state/);
 });
}
test('unexpected exceptions are counted without leaking their messages or aborting later services',async()=>{
 const h=harness(async(_env,id)=>{if(id===ids[0])throw new Error('secret-fixture-exception');return{state:'ok'};});
 await assert.rejects(h.run({}),incomplete);
 const summary=checkSummary(h,'failed');
 assert.equal(summary.counts.unexpected_failure,1);assert.equal(summary.counts.ok,ids.length-1);
 const unexpected=JSON.parse(h.errors[0]);
 assert.equal(unexpected.runId,summary.runId);assert.equal(unexpected.service,ids[0]);
 assert.doesNotMatch(h.errors.join('\n'),/secret-fixture-exception/);
});
test('all service failures still produce one complete summary and a failed Cron promise',async()=>{
 const h=harness(async()=>({state:'failed'}));
 await assert.rejects(h.run({}),incomplete);
 assert.equal(checkSummary(h,'failed').counts.failed,ids.length);
 assert.equal(h.errors.length,1);
});

for(const mode of ['ok','all_save_failures','audit_start_unavailable_prior_success','failure_audit_unavailable','success_audit_unavailable','prune_failure_audit_unavailable']) {
 test(`actual backups and persisted status: ${mode}`,async t=>{
  const dbs=Object.fromEntries(ids.map(id=>[id,database(id)]));
  const bucket=new Bucket(),env={BACKUP:bucket,SECURITY_AUDIT:{async send(){throw new Error('secret-fixture-queue');}}};
  for(const id of ids)env[SERVICES[id].binding]=d1(dbs[id]);
  let auditDown=false;
  const h=harness(async(e,id,now)=>{return backupService(e,id,now,async()=>{});});
  t.mock.method(console,'error',value=>h.errors.push(value));
  env.SECURITY={async recordAuditEvent(event){
   if(auditDown||(mode==='failure_audit_unavailable'&&event.eventType==='backup_failed')
    ||(mode==='success_audit_unavailable'&&event.eventType==='backup_succeeded')
    ||(mode==='prune_failure_audit_unavailable'&&event.eventType==='backup_prune_failed'))throw new Error('secret-fixture-audit');
   dbs.security.prepare('INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,target_type,target_id,details_json) VALUES(?,?,?,?,?,?,?,?)')
    .run(event.eventId,event.occurredAt,event.service,event.eventType,event.outcome,event.targetType,event.targetId,JSON.stringify(event.details));
   return{stored:true};
  }};
  try {
   if(mode==='audit_start_unavailable_prior_success'){
    for(const id of ids)assert.equal((await backupService(env,id,scheduledTime,async()=>{})).state,'ok');
    auditDown=true;
   }
   if(['all_save_failures','failure_audit_unavailable'].includes(mode))bucket.failPut=true;
   if(mode==='prune_failure_audit_unavailable'){
    for(const id of ids){
     const bytes=await compress(await capture(env[SERVICES[id].binding],id,scheduledTime));
     const sha256=await digest(bytes);
     for(let day=1;day<=31;day++)await bucket.put(`d1/${id}/v2/daily/${new Date(scheduledTime-day*86400000).toISOString().slice(0,10)}.json.gz`,bytes,{customMetadata:{sha256}});
    }
    const remove=bucket.delete.bind(bucket);
    bucket.delete=async keys=>{if(Array.isArray(keys)&&keys.some(key=>key.includes('/daily/')))throw new Error('secret-fixture-retention');return remove(keys);};
   }
   const writesBefore=bucket.writes.length;
   if(mode==='ok')await h.run(env);else await assert.rejects(h.run(env),incomplete);
   const summary=checkSummary(h,mode==='ok'?'ok':'failed');
   const snapshot=await getBackupSnapshot(env,{}, {async match(){},async put(){}});
   const states=ids.map(id=>snapshot.services.find(service=>service.id===id).state);
   if(mode==='ok')assert.equal(summary.counts.ok,ids.length);
   if(mode==='all_save_failures'){
    assert.equal(summary.counts.failed,ids.length);assert.ok(states.every(state=>state==='failed'));
    assert.equal(bucket.writes.length,writesBefore);
   }
   if(mode==='audit_start_unavailable_prior_success'){
    assert.equal(summary.counts.audit_unavailable,ids.length);assert.ok(states.every(state=>state==='ok'));
    assert.equal(bucket.writes.length,writesBefore,'no backup starts when both audit paths are unavailable');
   }
   if(mode==='failure_audit_unavailable'){
    assert.equal(summary.counts.failed,ids.length);assert.ok(states.every(state=>state==='running'));
   }
   if(mode==='success_audit_unavailable'){
    assert.equal(summary.counts.audit_unavailable,ids.length);assert.ok(states.every(state=>state==='running'));
    assert.equal([...bucket.objects.keys()].filter(key=>key.includes('/daily/')).length,ids.length);
   }
   if(mode==='prune_failure_audit_unavailable'){
    assert.equal(summary.counts.prune_failed,ids.length);assert.ok(states.every(state=>state==='ok'));
    assert.equal([...bucket.objects.keys()].filter(key=>key.includes('/daily/')).length,ids.length*32,'retention failure preserves existing generations');
   }
   assert.doesNotMatch([...h.info,...h.errors].join('\n'),/secret-fixture|sensitive payload/);
  }finally{for(const db of Object.values(dbs))db.close();}
 });
}
