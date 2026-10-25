import test from 'node:test';
import assert from 'node:assert/strict';
import { Bucket } from './fixtures.mjs';
import { backupPhotos,restorePhotos } from '../../diary-worker/src/photo-backup.js';

const photo={id:'synthetic',original_size:3,original_key:'source/original',display_key:'source/display',thumbnail_key:'source/thumbnail'};
async function fixture(){const env={MEDIA:new Bucket(),BACKUP:new Bucket()};for(const c of ['original','display','thumbnail']) await env.MEDIA.put(photo[c+'_key'],new Uint8Array([1,2,3]));return env;}
const manifest=r=>({formatVersion:7,tables:{diary_photos:{rows:[photo]}},mediaBackup:{objects:r.objects}});
test('verified receipts require source and backup versions; corruption is detected and preserved for investigation',async()=>{
  const env=await fixture(), now=Date.now(), first=await backupPhotos(env,[photo],{now});
  assert.equal(first.complete,true);
  const key=first.objects[0].backupKey, old=env.BACKUP.objects.get(key);
  // Version unchanged bit corruption is found by periodic deep verification.
  old.bytes=new Uint8Array([9,9,9]);
  const next=await backupPhotos(env,[photo],{now:now+8*86400000});
  assert.equal(next.complete,false);
  assert.deepEqual(env.BACKUP.objects.get(key).bytes,new Uint8Array([9,9,9]));
  assert.equal((await restorePhotos({BACKUP:env.BACKUP,MEDIA:new Bucket()},manifest(first))).complete,false,'old corrupted generation must not claim restoration');
  assert.equal((await backupPhotos(env,[photo],{now:now+9*86400000})).complete,false,'failure persists until investigated');
});
test('missing source, changed source during copying, and invalid original size do not certify a generation',async()=>{
  for(const mode of ['missing','changed','size']) {
    const env=await fixture();
    if(mode==='missing') await env.MEDIA.delete(photo.original_key);
    if(mode==='changed') {const get=env.MEDIA.get.bind(env.MEDIA);let calls=0;env.MEDIA.get=async(...a)=>{if(++calls===2) await env.MEDIA.put(a[0],new Uint8Array([5,5,5]));return get(...a);};}
    assert.equal((await backupPhotos(env,[{...photo,original_size:mode==='size'?999:3}])).complete,false,mode);
  }
});
test('bounded verification resumes using receipts; missing SHA and mismatched destinations fail closed',async()=>{
  const env=await fixture(), now=Date.now();
  const first=await backupPhotos(env,[photo],{now,maxObjects:1});assert.equal(first.complete,false);assert.equal(first.pending,2);
  const second=await backupPhotos(env,[photo],{now,maxObjects:1});assert.equal(second.pending,1);
  const third=await backupPhotos(env,[photo],{now,maxObjects:1});assert.equal(third.complete,true);
  const target=new Bucket();await target.put(photo.original_key,new Uint8Array([8]));
  const result=await restorePhotos({MEDIA:target,BACKUP:env.BACKUP},manifest(third));assert.equal(result.complete,false);assert.equal(result.failed,1);
  assert.deepEqual(target.objects.get(photo.original_key).bytes,new Uint8Array([8]));
  await assert.rejects(restorePhotos(env,{...manifest(third),formatVersion:6}),/LegacyMediaUnverified/);
  const bad=manifest(third);delete bad.mediaBackup.objects[0].sha256;await assert.rejects(restorePhotos(env,bad),/MediaManifestInvalid/);
});
