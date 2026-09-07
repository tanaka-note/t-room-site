import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const part=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
function setup() {
  const db=new DatabaseSync(':memory:');
  for(const file of readdirSync(new URL('../migrations/',import.meta.url)).sort())db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  db.exec(`INSERT INTO downloader_jobs(id,identity_id,service_link_id,client_request_id,status,source_hostname,url_hash,object_key,expires_at) VALUES('job','owner','link','request','ready','example.com','hash','downloads/job/fixture',100)`);
  const deleted=[];
  const env={DB:{prepare(sql){return {bind(...args){return {async first(){return db.prepare(sql).get(...args)},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}},async all(){return {results:db.prepare(sql).all(...args)}}}}}}},DOWNLOADS:{async delete(key){deleted.push(key)}}};
  const context={Date,console,Response,nowSeconds:()=>101,sqliteUtcTimestamp:()=> '2000-01-01 00:00:00',cleanupOrphanObjects:async()=>{},auditSystem:async()=>{},HttpError:class extends Error{constructor(status,message){super(message);this.status=status}},safeRecordUsageItems:async()=>{},safeUsageIdentityId:x=>x,isFinalQueueAttempt:x=>x>=4,QUEUE_MAX_RETRIES:3,safeQueueJobId:x=>x,safeErrorName:e=>e.message,queueRetryDelaySeconds:()=>10};
  vm.createContext(context);
  vm.runInContext(part('async function ownedJob(','async function deleteOwnedJob(')+part('async function deleteOwnedJob(','async function cleanupOrphanObjects(')+part('export async function handleQueueBatch(','export class SecurityIntegration').replace('export ','')+';globalThis.remove=deleteJobObject;globalThis.owned=deleteOwnedJob;globalThis.serve=serveDownload;globalThis.cleanup=cleanupExpiredJobs;globalThis.queue=handleQueueBatch;',context);
  return {db,env,context,deleted};
}

test('manual deletion awaits R2 success, then marks deleted and blocks future file delivery',async()=>{
 const h=setup();try{let resolve;let started;const ready=new Promise(r=>started=r);h.env.DOWNLOADS.delete=()=>new Promise(r=>{resolve=r;started()});const pending=h.context.owned(h.env,{identityId:'owner'},'job');await ready;assert.equal(h.db.prepare('SELECT status FROM downloader_jobs').get().status,'ready');resolve();await pending;assert.equal(h.db.prepare('SELECT status,object_key FROM downloader_jobs').get().status,'deleted');assert.equal(h.db.prepare('SELECT object_key FROM downloader_jobs').get().object_key,null);await assert.rejects(h.context.serve({},h.env,{identityId:'owner'},'job'),e=>e.status===409||e.status===410);await h.context.owned(h.env,{identityId:'owner'},'job');}finally{h.db.close()}
});

test('R2 failure keeps the D1 object reference for retry; other owners cannot delete',async()=>{
 const h=setup();try{await assert.rejects(h.context.owned(h.env,{identityId:'other'},'job'),e=>e.status===404);assert.equal(h.deleted.length,0);h.env.DOWNLOADS.delete=async()=>{throw Error('R2 unavailable')};await assert.rejects(h.context.remove(h.env,'job','deleted'),/R2 unavailable/);assert.equal(h.db.prepare('SELECT status FROM downloader_jobs').get().status,'ready');assert.equal(h.db.prepare('SELECT object_key FROM downloader_jobs').get().object_key,'downloads/job/fixture');}finally{h.db.close()}
});

test('late expiry cannot replace confirmed manual deletion or double-count retirement',async()=>{
 const h=setup();try{let resolve;let started;const ready=new Promise(r=>started=r);let calls=0;h.env.DOWNLOADS.delete=async()=>{if(++calls===1)await new Promise(r=>{resolve=r;started()})};const expiry=h.context.remove(h.env,'job','expired');await ready;await h.context.owned(h.env,{identityId:'owner'},'job');resolve();await expiry;assert.equal(h.db.prepare('SELECT status FROM downloader_jobs').get().status,'deleted');assert.equal(h.db.prepare("SELECT sum(event_count) AS count FROM downloader_usage_daily WHERE metric='lifecycle'").get().count,1);}finally{h.db.close()}
});

test('expiry Queue acknowledges successful and duplicate deletion; R2 failure retries',async()=>{
 const h=setup();try{let ack=0,retry=0;const msg={body:{type:'delete',jobId:'job',identityId:'owner'},attempts:1,ack(){ack++},retry(){retry++}};h.env.DOWNLOADS.delete=async()=>{throw Error('R2 unavailable')};await h.context.queue({messages:[msg]},h.env);assert.equal(retry,1);assert.equal(ack,0);h.env.DOWNLOADS.delete=async()=>{};await h.context.queue({messages:[msg]},h.env);await h.context.queue({messages:[msg]},h.env);assert.equal(ack,2);assert.equal(h.db.prepare('SELECT status FROM downloader_jobs').get().status,'expired');}finally{h.db.close()}
});

test('Cron collects expired objects without acquiring a Container',async()=>{
 const h=setup();try{await h.context.cleanup(h.env);assert.deepEqual(h.deleted,['downloads/job/fixture']);assert.equal(h.db.prepare('SELECT status FROM downloader_jobs').get().status,'expired');}finally{h.db.close()}
});
