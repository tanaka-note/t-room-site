import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Bucket, d1, recorder } from '../../backup-worker/test/fixtures.mjs';
import { runPhotoBatch, runScheduledPhotoBackup, PHOTO_STATE_PREFIX } from '../src/photo-backup-job.js';
import { backupPhotos, bindPhotoIdentity, resolvePhotoManifest, restorePhotos, PHOTO_REVERIFY_MS } from '../src/photo-backup.js';
import { runScheduledDiaryBackup } from '../src/backup.js';

const initial = Date.parse('2026-10-30T18:55:00Z');
async function fixture(count = 1) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE diary_photos(id TEXT PRIMARY KEY,original_size INTEGER,original_key TEXT,display_key TEXT,thumbnail_key TEXT,created_at TEXT,backup_identity TEXT)');
  const env = { DB: d1(sql), MEDIA: new Bucket(), BACKUP: new Bucket(), ...recorder() };
  const add = async (id, date = '2026-10-01') => {
    const row = { id, original_size: 3, original_key: id+'/original', display_key: id+'/display', thumbnail_key: id+'/thumbnail', created_at: date, backup_identity: null };
    sql.prepare('INSERT INTO diary_photos VALUES(?,?,?,?,?,?,?)').run(...Object.values(row));
    for (const key of [row.original_key,row.display_key,row.thumbnail_key]) await env.MEDIA.put(key,new Uint8Array([1,2,3]));
    return row;
  };
  for(let i=0;i<count;i++) await add(String(i).padStart(5,'0'));
  let time = initial;
  const batch = options => runPhotoBatch(env, { now:time, clock:()=>time, ...options });
  return { env, sql, add, batch, next() { time+=10*60000; }, setTime(value) { time=value; } };
}

test('3,000 synthetic objects resume across bounded pages without repeated physical copies', async () => {
  const f = await fixture(1000); let copied = 0, run, attempts = 0, unknown = 3001;
  f.env.MEDIA.list = f.env.BACKUP.list = () => { throw new Error('No full bucket scans'); };
  while(attempts++ < 100) {
    run = await f.batch(); copied += run.copied;
    assert.ok(run.copied <= 40); assert.ok(run.processed <= 120); assert.ok(run.estimatedIoBytes <= 256*1024*1024);
    assert.ok(run.unknown < unknown || run.complete); unknown=run.unknown;
    if(run.complete) break;
    f.next();
  }
  assert.equal(run.complete,true); assert.equal(copied,3000); assert.equal(run.backedUp,3000); assert.equal(run.unknown,0);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/verified-photos/')).length,3000);
  f.next(); assert.equal((await f.batch()).copied,0);
  f.sql.close();
});

test('new arrivals bypass an old cursor; overdue verification never consumes the copy budget', async () => {
  const f = await fixture(3);
  await f.batch({maxObjects:1});
  const recent = await f.add('zz-new','2026-10-31');
  f.next(); const run = await f.batch({maxObjects:3});
  assert.equal(run.copied,3);
  assert.ok(f.env.BACKUP.writes.some(k=>k.startsWith('media/verified-photos/'+recent.id)));
  const small = await fixture();
  await small.batch(); small.setTime(initial+PHOTO_REVERIFY_MS+1);
  const row=await small.add('newer','2026-11-30');
  const copied=await small.batch({maxObjects:3}); assert.equal(copied.copied,3);
  assert.ok(small.env.BACKUP.writes.some(k=>k.startsWith('media/verified-photos/'+row.id)));
  small.next(); const verified = await small.batch({mode:'verify'});
  assert.equal(verified.copied,0); assert.equal(verified.reverified,3);
  f.sql.close(); small.sql.close();
});

test('D1 snapshot failure and photo failure use independent audit targets', async () => {
  const f = await fixture();
  f.env.DB.batch = async () => { throw new Error('synthetic snapshot failure'); };
  const d1Result=await runScheduledDiaryBackup(f.env,initial,{sleep:async()=>{}});
  assert.equal(d1Result.complete,false);
  assert.equal((await runScheduledPhotoBackup(f.env,initial,{clock:()=>initial})).copied,3);
  assert.ok(f.env.events.some(e=>e.targetId==='diary'&&e.eventType==='backup_failed'));
  assert.ok(f.env.events.some(e=>e.targetId==='diary-photos'&&e.eventType==='backup_succeeded'));
  f.next(); await runScheduledPhotoBackup(f.env,initial+600000,{mode:'verify',clock:()=>initial+600000});
  assert.ok(f.env.events.some(e=>e.targetId==='diary-photo-verification'));
  f.sql.close();
});

test('lease prevents duplicate invocations and survives worker restarts without deleting recovery objects', async () => {
  const f = await fixture(2);
  const runs=await Promise.all([f.batch(),f.batch()]);
  assert.equal(runs.filter(r=>r.skipped).length,1);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/verified-photos/')).length,6);
  assert.equal((await f.batch()).skipped,true);
  f.next(); assert.equal((await f.batch()).copied,0);
  const checkpoint=f.env.BACKUP.objects.get(PHOTO_STATE_PREFIX+'copy.json.gz');
  assert.ok(checkpoint);
  f.sql.close();
});

test('byte and time bounds resume; an oversized object does not pin the cursor', async () => {
  const f=await fixture(2);
  const first=await f.batch({maxBytes:18}); assert.equal(first.copied,1);
  f.next(); assert.equal((await f.batch()).copied,5);
  f.next(); const timed=await f.batch({maxMs:0}); assert.equal(timed.processed,0); assert.equal(timed.complete,false);
  f.next(); assert.equal((await f.batch()).copied,0);
  f.sql.close();
});

test('interruption after receipt save replays safely; network failure cannot publish a false receipt', async () => {
  const f=await fixture(); const put=f.env.BACKUP.put.bind(f.env.BACKUP); let fail=true;
  f.env.BACKUP.put=async(key,...rest)=>{if(fail&&key===PHOTO_STATE_PREFIX+'copy.json.gz'){fail=false;throw new Error('network');}return put(key,...rest);};
  await assert.rejects(f.batch(),/network/);
  f.next(); assert.equal((await f.batch()).copied,0);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/verified-photos/')).length,3);
  f.sql.close();
});

test('an unbound snapshot rejects even one later candidate after an in-place replacement', async () => {
  const f=await fixture(); const row={...f.sql.prepare('SELECT * FROM diary_photos').get()};
  const payload={formatVersion:8,backupScope:'d1-only',tables:{diary_photos:{rows:[row]}}};
  await f.env.MEDIA.put(row.original_key,new Uint8Array([9,9,9]));
  assert.equal((await f.batch()).copied,3);
  assert.equal([...f.env.BACKUP.objects.keys()].filter(k=>k.startsWith('media/photo-versions/'+row.id+'/original/')).length,1);
  await assert.rejects(resolvePhotoManifest(f.env.BACKUP,payload),/MediaIdentityUnproven/);
  const bound={...f.sql.prepare('SELECT * FROM diary_photos').get()};
  const paired=await resolvePhotoManifest(f.env.BACKUP,{...payload,tables:{diary_photos:{rows:[bound]}}});
  assert.equal((await restorePhotos({BACKUP:f.env.BACKUP,MEDIA:new Bucket()},paired)).complete,true);
  await assert.rejects(restorePhotos({BACKUP:f.env.BACKUP,MEDIA:new Bucket()},{...payload,mediaBackup:paired.mediaBackup}),/MediaIdentityUnproven/);
  f.sql.close();
});

test('a bound snapshot selects its exact hash across versions; a later overwrite cannot rebind it', async () => {
  const f=await fixture(); await f.batch();
  const bound={...f.sql.prepare('SELECT * FROM diary_photos').get()};
  const payload={formatVersion:8,backupScope:'d1-only',tables:{diary_photos:{rows:[bound]}}};
  const old=await resolvePhotoManifest(f.env.BACKUP,payload);
  await f.env.MEDIA.put(bound.original_key,new Uint8Array([9,9,9]));
  // A second candidate, created without a trusted D1 binding, cannot override it.
  assert.equal((await backupPhotos(f.env,[{...bound,backup_identity:null}])).copied,1);
  const paired=await resolvePhotoManifest(f.env.BACKUP,payload);
  assert.equal(paired.mediaBackup.objects[0].sha256,old.mediaBackup.objects[0].sha256);
  const destination=new Bucket();
  assert.equal((await restorePhotos({BACKUP:f.env.BACKUP,MEDIA:destination},paired)).complete,true);
  assert.deepEqual(new Uint8Array(await (await destination.get(bound.original_key)).arrayBuffer()),new Uint8Array([1,2,3]));
  f.next(); assert.equal((await f.batch()).corrupt,1);
  assert.equal(f.sql.prepare('SELECT backup_identity FROM diary_photos').get().backup_identity,bound.backup_identity);
  await assert.rejects(resolvePhotoManifest(f.env.BACKUP,payload),/CorruptPhoto/);
  f.sql.close();
});

test('transient failure retries ahead of a large backlog after restart and repairs inventory counts', async () => {
  const f=await fixture(100), get=f.env.MEDIA.get.bind(f.env.MEDIA); let fail=true;
  f.env.MEDIA.get=async(key,...args)=>{if(fail&&key==='00000/original'){fail=false;throw new Error('network');}return get(key,...args);};
  const first=await f.batch({maxObjects:2});
  assert.equal(first.failed,1); assert.equal(first.retryPending,1); assert.ok(first.unknown>200);
  f.next(); const second=await f.batch({maxObjects:1});
  assert.equal(second.retriesAttempted,1); assert.equal(second.retryPending,0); assert.equal(second.failed,0);
  assert.equal(second.copied,1); assert.ok(second.unknown>200);
  assert.ok(f.env.BACKUP.writes.some(k=>k.startsWith('media/verified-photos/00000/original/')));
  f.sql.close();
});

test('identity binding rejects a concurrently changed D1 reference and deeply verifies old receipts', async () => {
  const f=await fixture(); const row={...f.sql.prepare('SELECT * FROM diary_photos').get()};
  const copies=await backupPhotos(f.env,[row]);
  f.sql.prepare('UPDATE diary_photos SET thumbnail_key=?').run('changed');
  await assert.rejects(bindPhotoIdentity(f.env.DB,row,copies.objects[0]),/SourceChanged/);
  assert.equal(f.sql.prepare('SELECT backup_identity FROM diary_photos').get().backup_identity,null);
  f.sql.prepare('UPDATE diary_photos SET thumbnail_key=?').run(row.thumbnail_key);
  const get=f.env.MEDIA.get.bind(f.env.MEDIA); let reads=0;
  f.env.MEDIA.head=key=>get(key);
  f.env.MEDIA.get=async(...args)=>{reads++; return get(...args);};
  const run=await f.batch(); assert.equal(run.copied,0); assert.equal(reads,3);
  assert.ok(f.sql.prepare('SELECT backup_identity FROM diary_photos').get().backup_identity);
  f.sql.close();
});

test('priority retry journal is bounded and applies exponential backoff', async () => {
  const f=await fixture(100);
  f.env.MEDIA.get=async()=>{throw new Error('network');};
  for(let i=0;i<9;i++) { await f.batch(); f.next(); }
  const state=await (await import('../../backup-worker/src/integrity.js')).verifiedGeneration(f.env.BACKUP,PHOTO_STATE_PREFIX+'copy.json.gz',()=>{});
  assert.equal(state.payload.retries.length,256);
  const cursor=state.payload.cursor;
  assert.ok(cursor.id<'00099');
  assert.ok(state.payload.retries.every(t=>t.nextAttemptAt>initial));
  assert.ok(state.payload.retries.some(t=>t.attempts>1));
  f.sql.close();
});

test('a photo above the default single-object limit is oversized, never read or retried', async () => {
  const f=await fixture(2), head=f.env.MEDIA.head.bind(f.env.MEDIA), get=f.env.MEDIA.get.bind(f.env.MEDIA);
  const size=Math.floor(256*1024*1024/6)+1;
  f.sql.prepare('UPDATE diary_photos SET original_size=? WHERE id=?').run(size,'00000');
  f.env.MEDIA.head=async key=>key==='00000/original'?{etag:'large',size}:head(key);
  f.env.MEDIA.get=async(key,...args)=>{assert.notEqual(key,'00000/original');return get(key,...args);};
  const run=await f.batch();
  assert.equal(run.oversized,1); assert.equal(run.failed,0); assert.equal(run.retryPending,0);
  assert.equal(run.copied,5); assert.equal(run.complete,false); assert.ok(run.estimatedIoBytes<=256*1024*1024);
  f.sql.close();
});

test('initial catchup is limited to ten fixed slots/day and a fourteen-day window', async () => {
  const f=await fixture(2);
  assert.equal((await f.batch({catchup:true})).skipped,true);
  await f.batch({maxObjects:1});
  const slot=Date.parse('2026-10-30T19:05:00Z'); f.setTime(slot);
  const first=await f.batch({catchup:true,maxObjects:1}); assert.equal(first.copied,1);
  f.setTime(slot+5*60000+1);
  assert.equal((await f.batch({catchup:true,now:slot})).skipped,true,'the same reserved slot never repeats after a restart');
  f.setTime(slot+15*60000+2);
  await assert.rejects(f.batch({catchup:true}),/InvalidCatchupSlot/);
  f.setTime(initial+14*86400000);
  assert.equal((await f.batch({catchup:true})).skipped,true);
  assert.equal((await f.batch({catchup:true,now:slot+10*60000})).skipped,true,'a delayed trigger cannot extend the real deadline');
  f.sql.close();
});

test('expired lease fences receipt publication after an interrupted stream', async () => {
  const f=await fixture(), put=f.env.BACKUP.put.bind(f.env.BACKUP); let expired=false;
  f.env.BACKUP.put=async(key,...args)=>{
    const result=await put(key,...args);
    if(!expired&&key.startsWith('media/photo-versions/')) { expired=true; f.setTime(initial+5*60000+1); }
    return result;
  };
  await assert.rejects(f.batch(),/ConcurrentWrite/);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/photo-receipts/')).length,0);
  f.setTime(initial+10*60000);
  assert.equal((await f.batch()).complete,true);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/verified-photos/')).length,3);
  f.sql.close();
});

test('network failure leaves an unverified photo pending and later retries without damage', async () => {
  const f=await fixture(), get=f.env.MEDIA.get.bind(f.env.MEDIA); let fail=true;
  f.env.MEDIA.get=async(...args)=>{if(fail){fail=false;throw new Error('network');}return get(...args);};
  const first=await f.batch(); assert.equal(first.complete,false); assert.equal(first.failed,1); assert.equal(first.copied,2);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/photo-receipts/')).length,2);
  f.next(); const next=await f.batch(); assert.equal(next.complete,true); assert.equal(next.copied,1);
  assert.equal(f.env.BACKUP.writes.filter(k=>k.startsWith('media/verified-photos/')).length,3);
  f.sql.close();
});
