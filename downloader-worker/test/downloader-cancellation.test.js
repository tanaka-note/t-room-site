import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import * as domain from '../src/downloader-domain.js';
import {aggregateUsageRows} from '../src/downloader-usage.js';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const migrationFiles=readdirSync(new URL('../migrations/',import.meta.url)).sort();
const migrations=migrationFiles.map(f=>readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
const slice=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
function database(all=true){const db=new DatabaseSync(':memory:'); for(const sql of all?migrations:migrations.slice(0,-1))db.exec(sql);return db;}
function insert(db,id='job',status='analyzing') {db.prepare(`INSERT INTO downloader_jobs(id,identity_id,service_link_id,client_request_id,status,source_hostname,url_hash,processing_token,processing_lease_expires_at) VALUES (?,'owner','link',?,?, 'example.com','hash',NULL,NULL)`).run(id,id,status);}
function binding(db) {
  return { prepare(sql) {
    return { bind(...args) {
      return {
        async first() { return db.prepare(sql).get(...args); },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
        async all() { return { results: db.prepare(sql).all(...args) }; }
      };
    } };
  } };
}
function harness(db,container={async cancelAnalysis(){},async release(){}}){
  const events=[]; const context={...domain,Request,Response,AbortSignal,URL,console,Date,crypto,Math,
    HttpError: class extends Error {constructor(status,message){super(message);this.status=status}},
    ensureContainerConfigured(env){assert.ok(env.DOWNLOADER_CONTAINER)},getContainer(_ns,name){events.push(name);return container},
    json:Response.json,nowSeconds:()=>1000,safeErrorName:e=>e.message,
    audit:async(...args)=>events.push(args[3]),auditSystem:async(...args)=>events.push(args[3]),
    safeRecordUsageItems:async()=>{},safeUsageIdentityId:x=>x,QUEUE_MAX_RETRIES:3,
    isFinalQueueAttempt:x=>x>=4,safeQueueJobId:x=>x,queueRetryDelaySeconds:()=>10,
    decryptPrivatePayload:async()=>({url:'https://example.com/media.mp4'}),urlFingerprint:async()=> 'hash',
    normalizeSourceUrl:x=>new URL(x),maxFileBytes:()=>1024,isPolicyRestrictedHost:()=>false,
    requireHealthyContainer:async()=>{},resolveAnalysisSource:async(_c,url)=>({url,egressHosts:[]}),configureContainerEgress:async()=>{},
    normalizeAnalysis:async x=>({...x,media:x.media||[]}),releaseContainer:async c=>c.release(),
    cleanText:x=>x,markAnalysisFailed:async()=>{events.push('failed')},markDownloadFailed:async()=>{throw Error('unexpected')},
  };
  vm.createContext(context);
  vm.runInContext(slice('const CONTAINER_HEALTH_TIMEOUT_MS','const CONTAINER_RESPONSE_GRACE_MS')+
    slice('async function processAnalyzeMessage(','async function requestDownload(')+
    slice('async function ownedJob(','async function serveDownload(')+
    slice('export async function handleQueueBatch(','export class SecurityIntegration').replace('export ','')+
    slice('function requireMutation(','function ensureContainerConfigured(')+
    ';globalThis.apiCancel=cancelAnalysisJob;globalThis.analyze=processAnalyzeMessage;globalThis.queue=handleQueueBatch;globalThis.lease=ANALYSIS_LEASE_SECONDS;globalThis.mutation=requireMutation;',context);
  const env={DB:binding(db),DOWNLOADER_CONTAINER:{}};
  return {context,env,events,cancel:()=>context.apiCancel(new Request('https://example.com/downloader/api/jobs/job/cancel'),env,{identityId:'owner'},'job')};
}

test('migration preserves every job field, delivery, usage, foreign key and prior trigger',()=>{
 const db=database(false); try{
 insert(db,'job','ready'); insert(db,'failed','failed');
 db.exec(`INSERT INTO downloader_file_delivery_attempts(job_id,attempt_id,identity_id,day_jst,byte_count) VALUES('job','attempt','owner','2026-09-07',123)`);
 const tables=['downloader_jobs','downloader_file_delivery_attempts','downloader_usage_daily'];
 const snapshots=tables.map(t=>db.prepare('SELECT * FROM '+t).all());
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
 const columns=Object.keys(snapshots[0][0]).join(',');
 db.exec('BEGIN');db.exec(migrations.at(-1));db.exec('COMMIT');
 for(let i=0;i<tables.length;i++)assert.deepEqual(db.prepare(`SELECT ${i===0?columns:'*'} FROM ${tables[i]}`).all(),snapshots[i]);
 for(const t of triggers)assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(t.name).sql.replace(/\r\n/g,'\n'),t.sql.replace(/\r\n/g,'\n'));
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.throws(()=>insert(db,'invalid','invalid'),/CHECK/);
 assert.throws(()=>db.exec(`INSERT INTO downloader_file_delivery_attempts(job_id,attempt_id,identity_id,day_jst,byte_count) VALUES('missing','bad','owner','2026-09-07',1)`),/FOREIGN KEY/);
 // The restored delivery trigger must still add once after the migration.
 db.exec(`INSERT INTO downloader_file_delivery_attempts(job_id,attempt_id,identity_id,day_jst,byte_count) VALUES('job','second','owner','2026-09-07',12)`);
 assert.equal(db.prepare("SELECT event_count FROM downloader_usage_daily WHERE metric='delivery'").get().event_count,2);
 }finally{db.close()}
});

test('failed migration transaction restores original jobs and child rows',()=>{
 const db=database(false);try{insert(db);db.exec('BEGIN');db.exec(migrations.at(-1));assert.throws(()=>db.exec('SELECT nonexistent FROM downloader_jobs'));db.exec('ROLLBACK');assert.equal(db.prepare('SELECT status FROM downloader_jobs').get().status,'analyzing');assert.equal(db.prepare('PRAGMA table_info(downloader_jobs)').all().some(x=>x.name==='cancelled_at'),false);}finally{db.close()}
});

test('cancel commits D1 before stop, clears lease, audits and counts only once',async()=>{
 const db=database();try{insert(db);db.exec("UPDATE downloader_jobs SET processing_token='old',processing_lease_expires_at=9999,progress_stage='starting'");let stops=0;
 const h=harness(db,{async cancelAnalysis(){stops++;const row=db.prepare('SELECT * FROM downloader_jobs').get();assert.equal(row.status,'cancelled');assert.equal(row.processing_token,null);assert.equal(row.processing_lease_expires_at,null);assert.equal(row.progress_stage,null);assert.ok(row.cancelled_at)}});
 await Promise.all([h.cancel(),h.cancel()]);await h.cancel();
 const row=db.prepare('SELECT * FROM downloader_jobs').get();assert.ok(row.cancel_stop_completed_at);assert.ok(stops>=1&&stops<=2);
 assert.equal(h.events.filter(x=>x==='downloader_analyze_cancelled').length,1);
 const usage=aggregateUsageRows(db.prepare('SELECT * FROM downloader_usage_daily').all());assert.equal(usage.cancelled,1);assert.equal(usage.failed,0);assert.equal(usage.rejected,0);
 }finally{db.close()}
});

test('ownership, completed jobs and mutation protection reject cancellation',async()=>{
 const db=database();try{insert(db);const h=harness(db);
 await assert.rejects(h.context.apiCancel(new Request('https://example.com'),h.env,{identityId:'other'},'job'),e=>e.status===404);
 assert.equal(h.events.length,0);
 db.exec("UPDATE downloader_jobs SET status='analyzed'");await assert.rejects(h.cancel(),e=>e.status===409);assert.equal(h.events.length,0);
 const url=new URL('https://example.com/downloader/api/jobs/job/cancel');
 for(const headers of [{},{Origin:'https://other.com','Content-Type':'application/json'},{Origin:url.origin}])assert.throws(()=>h.context.mutation(new Request(url,{method:'POST',headers}),url),e=>e.status===403);
 h.context.mutation(new Request(url,{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json'}}),url);
 assert.match(source,/cancelMatch && request.method === "POST"\) \{\s*requireMutation\(request, url\)/);
 }finally{db.close()}
});

test('stop failure stays cancelled and repeated cancel retries only stop',async()=>{
 const db=database();try{insert(db);let calls=0;const h=harness(db,{async cancelAnalysis(){if(++calls===1)throw Error('stop_failed')}});
 await assert.rejects(h.cancel(),e=>e.status===503);assert.equal(db.prepare('SELECT status FROM downloader_jobs').get().status,'cancelled');assert.equal(db.prepare('SELECT cancel_stop_completed_at FROM downloader_jobs').get().cancel_stop_completed_at,null);
 await h.cancel();assert.equal(calls,2);assert.equal(h.events.filter(x=>x==='downloader_analyze_cancelled').length,1);
 }finally{db.close()}
});

for(const stopped of [false,true])test(`in-flight ${stopped?'stopped':'late successful'} analysis never overwrites cancelled; Queue acknowledges`,async()=>{
 const db=database();try{insert(db);let resolveFetch;let fetchStarted;const started=new Promise(r=>fetchStarted=r);let released=0;
 const container={async fetch(){fetchStarted();return new Promise(r=>resolveFetch=r)},async cancelAnalysis(){resolveFetch(stopped?new Response('{}',{status:503}):Response.json({media:[]}))},async release(){released++}};
 const h=harness(db,container);let ack=0,retry=0;const msg={body:{type:'analyze',jobId:'job',identityId:'owner'},attempts:1,ack(){ack++},retry(){retry++}};
 const running=h.context.queue({messages:[msg]},h.env);await started;
 assert.equal(db.prepare('SELECT processing_lease_expires_at FROM downloader_jobs').get().processing_lease_expires_at,1000+h.context.lease);assert.equal(h.context.lease,330);
 await h.cancel();await running;assert.equal(db.prepare('SELECT status FROM downloader_jobs').get().status,'cancelled');assert.equal(ack,1);assert.equal(retry,0);assert.equal(released,1);assert.ok(!h.events.includes('downloader_analyze_completed'));
 h.events.length=0;await h.context.queue({messages:[msg]},h.env);assert.equal(ack,2);assert.deepEqual(h.events,[]);
 }finally{db.close()}
});

test('normal analysis completes, releases container and preserves bounded retries on genuine failure',async()=>{
 const db=database();try{insert(db);let released=0;const h=harness(db,{async fetch(){return Response.json({media:[]})},async release(){released++}});await h.context.analyze(h.env,{jobId:'job',identityId:'owner'});assert.equal(db.prepare('SELECT status FROM downloader_jobs').get().status,'analyzed');assert.equal(released,1);assert.ok(h.events.includes('downloader_analyze_completed'));
 insert(db,'bad');let retries=0;h.context.decryptPrivatePayload=async()=>{throw Error('temporary')};await h.context.queue({messages:[{body:{type:'analyze',jobId:'bad',identityId:'owner'},attempts:1,ack(){assert.fail('failure acknowledged')},retry(options){assert.equal(options.delaySeconds,10);retries++}}]},h.env);assert.equal(retries,1);
 }finally{db.close()}
});

test('cancellation during supplemental exploration fences late result and acknowledges redelivery',async()=>{
 const db=database();try{insert(db);let started,finish;const ready=new Promise(r=>started=r);let stopped=0,released=0;
 const h=harness(db,{async fetch(){return Response.json({errorCode:'media_not_found'},{status:422})},async cancelAnalysis(){stopped++;finish({extractor:'main-video',media:[]})},async release(){released++}});
 h.env.MAIN_VIDEO_FALLBACK='true';h.context.exploreMainVideo=async()=>{started();return new Promise(r=>finish=r)};
 let ack=0,retry=0;const message={body:{type:'analyze',jobId:'job',identityId:'owner'},attempts:1,ack(){ack++},retry(){retry++}};
 const pending=h.context.queue({messages:[message]},h.env);await ready;await h.cancel();await pending;
 assert.equal(db.prepare('SELECT status FROM downloader_jobs').get().status,'cancelled');assert.equal(stopped,1);assert.equal(released,1);assert.equal(ack,1);assert.equal(retry,0);
 h.context.exploreMainVideo=()=>assert.fail('redelivery explored');await h.context.queue({messages:[message]},h.env);assert.equal(ack,2);
 }finally{db.close()}
});

function containerClass(storage,forward){
 const calls=[];
 class Base {constructor(){this.ctx={storage:{async get(k){return storage.get(k)},async put(k,v){calls.push('persist');storage.set(k,v)}}}} async containerFetch(request){calls.push('fetch');return forward(request)}async destroy(){calls.push('destroy')}async stop(){calls.push('stop')}renewActivityTimeout(){} }
 const ctx={Container:Base,PRIVATE_DESTINATIONS:[],Request,Response,AbortController,AbortSignal,URL,setTimeout,clearTimeout};vm.createContext(ctx);
 vm.runInContext(slice('export class DownloaderContainer','DownloaderContainer.outboundByHost').replace('export ','')+';globalThis.C=DownloaderContainer;',ctx);
 return {instance:new ctx.C(),calls};
}

test('Container cancellation fences startup, aborts in-flight fetch, persists across eviction; normal release stays graceful',async()=>{
 const storage=new Map();let started;const ready=new Promise(r=>started=r);
 const {instance,calls}=containerClass(storage,request=>new Promise(resolve=>{started();request.signal.addEventListener('abort',()=>resolve(new Response('aborted',{status:503})))}));
 const running=instance.fetch(new Request('http://container/ready'));await ready;await instance.cancelAnalysis();await running;
 assert.deepEqual(calls,['fetch','persist','destroy','destroy']);
 assert.equal((await instance.fetch(new Request('http://container/analyze'))).status,409);
 const recreated=containerClass(storage,()=>{assert.fail('cancelled container restarted')});assert.equal((await recreated.instance.fetch(new Request('http://container/ready'))).status,409);
 const normal=containerClass(new Map(),async()=>Response.json({ok:true}));await normal.instance.fetch(new Request('http://container/ready'));await normal.instance.release();assert.deepEqual(normal.calls,['fetch','stop']);
});

test('Container destroy repeats after an already-pending startup settles',async()=>{
 let finish;let started;const ready=new Promise(r=>started=r);const {instance,calls}=containerClass(new Map(),()=>new Promise(r=>{finish=r;started()}));
 const running=instance.fetch(new Request('http://container/ready'));await ready;const cancellation=instance.cancelAnalysis();await new Promise(setImmediate);
 assert.equal(calls.filter(x=>x==='destroy').length,1);finish(new Response('late startup'));await cancellation;await running;assert.equal(calls.filter(x=>x==='destroy').length,2);
});

test('D1 cancellation write failure never stops the Container',async()=>{
 const db=database();try{insert(db);const h=harness(db);const original=h.env.DB.prepare;h.env.DB.prepare=sql=>{if(sql.includes("SET status = 'cancelled'"))throw Error('D1 unavailable');return original(sql)};
 await assert.rejects(h.cancel(),/D1 unavailable/);assert.deepEqual(h.events,[]);assert.equal(db.prepare('SELECT status FROM downloader_jobs').get().status,'analyzing');
 }finally{db.close()}
});

test('cancel route authenticates before checking CSRF and reaching owned job',async()=>{
 const db=database();try{insert(db);const h=harness(db);Object.assign(h.context,{BASE_PATH:'/downloader',scheduleUsage(){},requireSession:async()=>{throw new h.context.HttpError(401,'login')}});
 vm.runInContext(slice('async function handleRequest(','async function completePasskeyHandoff(')+';globalThis.route=handleRequest;',h.context);
 const request=new Request('https://example.com/downloader/api/jobs/job/cancel',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:'{}'});
 await assert.rejects(h.context.route(request,h.env,{}),e=>e.status===401);assert.equal(h.events.length,0);
 h.context.requireSession=async()=>({identityId:'owner'});const result=await h.context.route(request,h.env,{});assert.equal(result.status,200);assert.equal((await result.json()).job.status,'cancelled');
 }finally{db.close()}
});

test('cancelled redelivery needs no Container binding; cancellation during initial storage read prevents startup',async()=>{
 const db=database();try{insert(db);const h=harness(db);await h.cancel();h.events.length=0;delete h.env.DOWNLOADER_CONTAINER;await h.context.analyze(h.env,{jobId:'job',identityId:'owner'});assert.deepEqual(h.events,[]);}finally{db.close()}
 const {instance,calls}=containerClass(new Map(),()=>assert.fail('started after cancellation'));
 const pending=instance.fetch(new Request('http://container/ready'));await instance.cancelAnalysis();assert.equal((await pending).status,409);assert.ok(!calls.includes('fetch'));
});
