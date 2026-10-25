import test from 'node:test';
import assert from 'node:assert/strict';
import { database,d1,Bucket,recorder } from './fixtures.mjs';
import { capture,backupService,prune,validateSnapshot } from '../src/backup.js';
import { compress,decode,digest,publishGeneration,verifiedPut,verifiedGeneration,readBounded } from '../src/integrity.js';
import { snapshotStatement,snapshotTables } from '../src/snapshot.js';

test('CAS concurrent writers preserve one independently verified generation',async()=>{
  const b=new Bucket(), validate=p=>assert.ok(p.version);
  const [a,c]=await Promise.all([compress({version:1}),compress({version:2})]);
  const results=await Promise.all([publishGeneration(b,'daily/key',a,{},validate),publishGeneration(b,'daily/key',c,{},validate)]);
  assert.equal(results.filter(r=>r.created).length,1);
  assert.equal(results[0].sha256,results[1].sha256);
  assert.equal((await verifiedGeneration(b,'daily/key',validate)).sha256,results[0].sha256);
  assert.equal([...b.objects.keys()].filter(k=>k.startsWith('attempts/')).length,0);
});
test('legacy, damaged, and semantically invalid generations are preserved and rejected',async()=>{
  for(const mode of ['legacy','damaged','semantic']) {
    const b=new Bucket(), bytes=await compress({version:1});
    const validate=p=>{if(p.version!==2) throw new Error('SnapshotInvalid');};
    await b.put('key',bytes,{customMetadata:mode==='legacy'?{}:{sha256:mode==='damaged'?'a'.repeat(64):await digest(bytes)}});
    await assert.rejects(publishGeneration(b,'key',await compress({version:2}),{},validate));
    assert.deepEqual(b.objects.get('key').bytes,bytes);
  }
});
test('failure after public put resumes via full readback, monthly failure is never successful',async()=>{
  const db=database('health'), b=new Bucket(), r=recorder(), env={HEALTH_DB:d1(db),BACKUP:b,...r};
  try {
    const get=b.get.bind(b); let failed=false;
    b.get=async key=>{if(key.includes('/daily/')&&!failed){failed=true;throw new Error('interrupted');} return get(key);};
    assert.equal((await backupService(env,'health',Date.now(),async()=>{})).state,'ok');
    const put=b.put.bind(b); b.put=async(key,...args)=>{if(key.includes('/monthly/')) throw new Error('monthly');return put(key,...args);};
    // A different month forces monthly creation; earlier verified generations survive.
    assert.equal((await backupService(env,'health',Date.parse('2027-01-01'),async()=>{})).state,'failed');
    assert.equal(r.events.at(-1).eventType,'backup_failed');
    assert.ok([...b.objects.keys()].some(k=>k.includes('/monthly/')));
  } finally {db.close();}
});
test('prune validates all retained generations before deleting any old recovery point',async()=>{
  const b=new Bucket(), data=await compress({version:1}), validate=p=>assert.equal(p.version,1);
  for(let i=1;i<=4;i++) await verifiedPut(b,`v2/daily/2026-01-0${i}.json.gz`,data);
  b.objects.get('v2/daily/2026-01-03.json.gz').bytes=new Uint8Array([0]);
  await assert.rejects(prune(b,'v2/daily/',2,validate));
  assert.equal(b.objects.size,4);
});
test('SQLite bounds and unsafe integer guard suppress payload before it enters JS',async()=>{
  const db=database('health'), api=d1(db), table={name:'health_records',columns:['record_id','account_id','iv','ciphertext','revision','updated_at']};
  try {
    const insert=db.prepare("INSERT INTO health_records VALUES (?,'nobumi','iv',?,1,'2026-01-01')");
    for(let i=0;i<5;i++) insert.run('r'+i,'text'.repeat(100));
    for(const bounds of [{rows:3},{bytes:100}]) {
      const result=await snapshotStatement(api,[table],bounds).all();
      assert.equal(result.results[0].allowed,0);
      assert.ok(result.results.slice(1).every(r=>r.rowJson===null));
      assert.throws(()=>snapshotTables(result),/SnapshotTooLarge/);
    }
    db.exec("UPDATE health_records SET revision=9007199254740992 WHERE record_id='r0'");
    await assert.rejects(capture(api,'health'),/UnsafeInteger/);
    await assert.rejects(readBounded(new Blob([new Uint8Array(100)]).stream(),10),/SnapshotTooLarge/);
    // A row exceeds D1's result cell safety margin: no oversized JSON cell returned.
    db.exec("UPDATE health_records SET revision=1,ciphertext=printf('%.*c',1100000,'x') WHERE record_id='r0'");
    await assert.rejects(capture(api,'health'),/SnapshotTooLarge/);
  } finally {db.close();}
});
test('snapshot format validation rejects omitted tables despite valid compression/hash',async()=>{
  const db=database('security');
  try {const p=await capture(d1(db),'security'); delete p.tables.security_credentials; assert.throws(()=>validateSnapshot(p,'security'),/SnapshotInvalid/);} finally{db.close();}
});

test('DDL drift with unchanged columns also stops publication',async()=>{
 const db=database('health');try{db.exec('CREATE INDEX unexpected_revision_index ON health_records(revision)');await assert.rejects(capture(d1(db),'health'),/SchemaReviewRequired/);}finally{db.close();}
});
