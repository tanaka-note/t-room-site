import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDiaryEntryDomain } from '../src/entry-domain.js';
import { assertOperation, retirePhotoBackups, PHOTO_PREFIXES } from '../scripts/retire-photo-backups.mjs';
const base = '/accounts/277e86de986181599ce0db2b3ca1f186';
const objects = `${base}/r2/buckets/t-room-diary-backups/objects`;
test('destructive operations can target only explicit photo-backup keys', () => {
  for (const prefix of PHOTO_PREFIXES) assert.doesNotThrow(() => assertOperation({ method: 'DELETE', path: objects, body: [prefix + 'fixture'] }));
  for (const options of [
    { method: 'DELETE', path: objects.replace('t-room-diary-backups','t-room-diary-media'), body: ['media/formal-photos/fixture'] },
    { method: 'DELETE', path: objects, body: ['v9/daily/2026-11-10.json.gz'] },
    { method: 'DELETE', path: objects, body: ['payments/pre-migration/fixture'] },
    { method: 'DELETE', path: objects, query: { prefix: '' }, body: ['media/verified-photos/fixture'] },
    { method: 'DELETE', path: objects, body: [] },
    { method: 'DELETE', path: objects.replace('/objects','') },
    { method: 'PUT', path: `${base}/workers/scripts/t-room-diary/schedules`, body: [] }
  ]) assert.throws(() => assertOperation(options), /RetirementOperationRejected/);
});
function fixture() {
  let crons = ['25 18 * * *','55 18 * * *','45 0-2,19-23 * * *','5,15,25,35,55 19,20 * * *'];
  const all = [...PHOTO_PREFIXES.map(prefix=>({ key: prefix+'fixture', size: 10, etag: 'fixture', last_modified:'2026-11-01T00:00:00Z' })),
    ...['v9/daily/fixture','v9/data/fixture','daily/fixture','payments/pre-migration/fixture'].map(key=>({key,size:1,etag:'keep'}))];
  const writes=[];
  return { all, writes, now:()=>Date.parse('2026-11-09T15:00:00Z'), async request(o) {
    if (o.method !== 'GET') writes.push(o);
    if (o.path.endsWith('/schedules')) {
      if (o.method === 'PUT') crons=o.body.map(x=>x.cron);
      return { result:{ schedules:crons.map(cron=>({cron})) } };
    }
    if (o.method === 'DELETE') { for (const key of o.body) all.splice(all.findIndex(x=>x.key===key),1); return {result:null}; }
    if (o.path.includes('t-room-diary-media')) return {result:[{key:'diary/staging/formal-original',size:99,etag:'original'}]};
    return {result:[...all]};
  } };
}
test('dry run is read-only; apply stops only photo schedules and preserves D1 and main media', async () => {
  const f=fixture(); await retirePhotoBackups({...f,log:()=>{}}); assert.equal(f.writes.length,0);
  const result=await retirePhotoBackups({...f,apply:true,log:()=>{}});
  assert.equal(result.deletedObjects,6); assert.equal(result.protectedBackupObjectsUnchanged,true);
  assert.equal(result.mainMediaSampleUnchanged,true); assert.equal(f.all.length,4);
  assert.equal(f.writes[0].method,'PUT'); assert.deepEqual(f.writes[0].body,[{cron:'25 18 * * *'}]);
});
test('an active photo invocation prevents deletion after schedule stop', async()=>{
  const f=fixture(); f.all.find(o=>o.key.startsWith('_metadata/')).last_modified=new Date(f.now()).toISOString();
  await assert.rejects(retirePhotoBackups({...f,apply:true,log:()=>{}}),/PhotoJobStillActive/);
  assert.equal(f.writes.some(o=>o.method==='DELETE'),false);
});
test('schedule propagation window blocks all mutations', async()=>{
  const f=fixture();
  await assert.rejects(retirePhotoBackups({...f,apply:true,now:()=>Date.parse('2026-11-09T19:00:00Z'),log:()=>{}}),/PhotoCronPropagationWindow/);
  assert.equal(f.writes.length,0);
});
test('Diary schedules only D1 and its normal cleanup, and the snapshot requests only D1 status', async()=>{
  const pending=[], statuses=[];
  const context={ WorkerEntrypoint:class{}, TextEncoder, TextDecoder, console, createDiaryEntryDomain,
    getBackupSnapshot:async()=>({backupBytes:7}), scheduleIndependentTasks:(_context,tasks)=>pending.push(...tasks) };
  const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/gm,'').replace(/export class (\w+)/g,'globalThis.$1 = class $1')
    .replace('export default {','globalThis.worker = {').replace(/export \{[\s\S]*?\};?/g,'');
  vm.runInNewContext(source,context);
  await context.worker.scheduled({cron:'25 18 * * *',scheduledTime:1},{},{});
  assert.equal(pending.length,3);
  for(const cron of ['55 18 * * *','45 0-2,19-23 * * *','5,15,25,35,55 19,20 * * *']) {
    await assert.rejects(context.worker.scheduled({cron,scheduledTime:1},{},{}),/UnknownDiaryCron/);
  }
  assert.equal(pending.length,3);
  const result=await context.BackupBrowserIntegration.prototype.getSnapshot.call({env:{ SECURITY:{getBackupStatus:async id=>{statuses.push(id);return{state:'ok'};}} }});
  assert.deepEqual(statuses,['diary']); assert.equal(result.backupBytes,7);
  assert.equal(result.photoStatus,undefined); assert.equal(result.verificationStatus,undefined);
});
