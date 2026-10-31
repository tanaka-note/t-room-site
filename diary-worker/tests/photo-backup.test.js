import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Bucket, d1, recorder } from '../../backup-worker/test/fixtures.mjs';
import { runPhotoBatch, runScheduledPhotoBackup, PHOTO_STATE_PREFIX } from '../src/photo-backup-job.js';
import { backupPhotos, resolvePhotoManifest, restorePhotos, PHOTO_REVERIFY_MS } from '../src/photo-backup.js';
import { runScheduledDiaryBackup } from '../src/backup.js';

const initial = Date.parse('2026-10-30T18:55:00Z');
async function fixture(count = 1) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE diary_photos(id TEXT PRIMARY KEY,original_size INTEGER,original_key TEXT,display_key TEXT,thumbnail_key TEXT,created_at TEXT)');
  const env = { DB: d1(sql), MEDIA: new Bucket(), BACKUP: new Bucket(), ...recorder() };
  const add = async (id, date = '2026-10-01') => {
    const row = { id, original_size: 3, original_key: id+'/original', display_key: id+'/display', thumbnail_key: id+'/thumbnail', created_at: date };
    sql.prepare('INSERT INTO diary_photos VALUES(?,?,?,?,?,?)').run(...Object.values(row));
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

test('changed photos retain history; ambiguous in-place versions cannot be paired by timestamps', async () => {
  const f=await fixture(); const row={...f.sql.prepare('SELECT * FROM diary_photos').get()};
  const old=await backupPhotos(f.env,[row]);
  await f.env.MEDIA.put(row.original_key,new Uint8Array([9,9,9]));
  const changed=await backupPhotos(f.env,[row]); assert.equal(changed.copied,1); assert.equal(changed.existing,2);
  const payload={formatVersion:8,backupScope:'d1-only',tables:{diary_photos:{rows:[row]}}};
  await assert.rejects(resolvePhotoManifest(f.env.BACKUP,payload),/AmbiguousMediaVersion/);
  assert.ok(f.env.BACKUP.objects.has(old.objects[0].backupKey));
  const remapped={...row,original_key:'new-key'}; await f.env.MEDIA.put(remapped.original_key,new Uint8Array([9,9,9]));
  await backupPhotos(f.env,[remapped]);
  const paired=await resolvePhotoManifest(f.env.BACKUP,{...payload,tables:{diary_photos:{rows:[remapped]}}});
  assert.equal((await restorePhotos({BACKUP:f.env.BACKUP,MEDIA:new Bucket()},paired)).complete,true);
  await assert.rejects(resolvePhotoManifest(f.env.BACKUP,{...payload,tables:{diary_photos:{rows:[{...row,thumbnail_key:'unbacked'}]}}}),/MediaManifestIncomplete/);
  f.sql.close();
});

test('initial catchup is limited to ten fixed slots/day and a fourteen-day window', async () => {
  const f=await fixture(2);
  assert.equal((await f.batch({catchup:true})).skipped,true);
  await f.batch({maxObjects:1});
  const slot=Date.parse('2026-10-30T19:05:00Z'); f.setTime(slot);
  const first=await f.batch({catchup:true,maxObjects:1}); assert.equal(first.copied,1);
  f.setTime(slot+5*60000+1); // same reserved slot is never silently repeated
  await assert.rejects(f.batch({catchup:true}),/InvalidCatchupSlot/);
  f.setTime(initial+14*86400000); assert.equal((await f.batch({catchup:true})).skipped,true);
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
