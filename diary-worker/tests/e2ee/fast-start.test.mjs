import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { provision, fixture, entry } from './fixture.mjs';
import { EncryptedDiaryClient } from '../../e2ee/client.mjs';

let prepared;
before(async()=>{prepared=await provision();});
function memoryCache() {
  const snapshots=new Map(),indexes=new Map(),points=new Map();
  return {snapshots,indexes,points,
    get:async key=>structuredClone(snapshots.get(key)),
    getIndex:async key=>structuredClone(indexes.get(key)),
    checkpoint:async key=>points.get(key)||0,
    put:async(key,value,point)=>{if((points.get(point)||0)>value.sequence)throw new Error('CacheRollbackRejected');snapshots.set(key,structuredClone(value));points.set(point,value.sequence);indexes.delete(key);},
    putIndex:async(key,sequence,envelope)=>{if(snapshots.get(key)?.sequence===sequence){indexes.set(key,structuredClone({sequence,envelope}));return true;}}
  };
}
async function setup(count=24,{sameDay=false}={}) {
  const f=await fixture(prepared),writer=await f.client('ownerA'),cache=memoryCache();
  writer.documentFormat=2;
  for(let i=1;i<=count;i++)await writer.commit(entry({entryDate:sameDay?'2026-01-01':new Date(Date.UTC(2026,0,i)).toISOString().slice(0,10),lastPublishedAt:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),title:`PRIVATE_INDEX_TITLE_${i}`,content:`PRIVATE_INDEX_BODY_${i}`}),{id:String(i)},{refresh:false});
  const create=async actor=>{
    const c=new EncryptedDiaryClient({transport:writer.transport,profile:{...writer.profile,...(actor?{actor}:{})},anchor:prepared.anchor,lazy:true,cache});
    await c.unlock(new Uint8Array(prepared.secrets.ownerA.prf));return c;
  };
  const cold=await create();await cold.sync();await cold.ensureList(new URLSearchParams({limit:'3'}));await cold.persistPreparedIndex();cold.lock();
  const warm=await create();
  return {f,writer,cold,warm,cache,create,close(){writer.lock();warm.lock();f.close();}};
}
async function countCrypto(run) {
  const decrypt=crypto.subtle.decrypt,verify=crypto.subtle.verify;
  const counts={decrypt:0,verify:0};
  crypto.subtle.decrypt=async function(...args){counts.decrypt++;return decrypt.apply(this,args);};
  crypto.subtle.verify=async function(...args){counts.verify++;return verify.apply(this,args);};
  try{await run(counts);return counts;}
  finally{crypto.subtle.decrypt=decrypt;crypto.subtle.verify=verify;}
}

test('a new authenticated session restores a sealed index, then verifies only its first visible bodies',async()=>{
  const x=await setup();try {
    let since;const snapshot=x.warm.transport.snapshot;x.warm.transport={...x.warm.transport,snapshot:async(h,s)=>{since=s;return snapshot(h,s);}};
    await countCrypto(async counts=>{
      await x.warm.sync();assert.ok(since>=0,'only server deltas are requested');
      assert.equal(counts.verify,0);assert.equal(counts.decrypt,1,'one local encrypted index replaces every summary decryption');
      assert.equal(x.warm.records.size,24);assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,0);
      await x.warm.ensureList(new URLSearchParams({limit:'3'}));assert.equal(counts.verify,3,'visible bodies still pass real record signatures');
      assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,3);
      assert.equal(x.warm.list(new URLSearchParams({limit:'3'})).entries[0].title,'PRIVATE_INDEX_TITLE_24');
    });
    const stored=JSON.stringify([...x.cache.snapshots,...x.cache.indexes]);
    assert.equal(stored.includes('PRIVATE_INDEX_TITLE_'),false);assert.equal(stored.includes('PRIVATE_INDEX_BODY_'),false);
    await x.warm.startBackground();assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,24);
  }finally{x.close();}
});
test('sealed publication order avoids decrypting every same-day tie before the first three entries',async()=>{
  const x=await setup(24,{sameDay:true});try{
    await x.warm.sync();await x.warm.ensureList(new URLSearchParams({limit:'3'}));
    assert.deepEqual(x.warm.list(new URLSearchParams({limit:'3'})).entries.map(e=>e.id),[24,23,22]);
    assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,3);
  }finally{x.close();}
});
test('fresh additions, edits and removals are reconciled before a cached list becomes visible',async()=>{
  const x=await setup(12);try{
    await x.writer.sync();await x.writer.saveEntry({...x.writer.entry('1'),title:'CURRENT_TITLE',entryDate:'2030-01-01'},'1');
    await x.writer.transition('2','trash',x.writer.entry('2').revision);await x.writer.transition('2','purge',x.writer.records.get('2').row.revision);
    await x.writer.commit(entry({entryDate:'2031-01-01',title:'NEW_CURRENT_TITLE',photos:[]}),{id:'100'},{refresh:false});
    await x.warm.sync({parallelStartupRead:true});await x.warm.ensureList(new URLSearchParams({limit:'3'}));
    assert.deepEqual(x.warm.list(new URLSearchParams({limit:'3'})).entries.map(e=>e.id),[100,1,12]);
    assert.equal(x.warm.entry('1').title,'CURRENT_TITLE');assert.equal(x.warm.records.has('2'),false);
  }finally{x.close();}
});

for(const revokedAt of [0,1,2])test(`startup overlaps the delta and honors both live sync checks (revocation at ${revokedAt||'neither'})`,{timeout:10000},async()=>{
  const x=await setup(6);
  const firstCheck=Promise.withResolvers(),deltaRequested=Promise.withResolvers(),lastCheck=Promise.withResolvers(),lastRequested=Promise.withResolvers();
  try {
    const warm=x.warm,transport=warm.transport,readIndex=warm.readPreparedIndex.bind(warm);
    let checks=0,indexReads=0;
    warm.readPreparedIndex=(...args)=>{indexReads++;return readIndex(...args);};
    warm.transport={...transport,
      valid:async()=>{if(++checks===1)return firstCheck.promise;lastRequested.resolve();return lastCheck.promise;},
      snapshot:async(h,since,options)=>{assert.ok(since>=0);deltaRequested.resolve(options.signal);return transport.snapshot(h,since,options);}
    };
    const pending=warm.sync({parallelStartupRead:true});
    const result=revokedAt?assert.rejects(pending,{status:401}):pending;
    const signal=await deltaRequested.promise;
    assert.equal(checks,1);
    assert.equal(indexReads,0,'the encrypted index stays sealed until session validation');
    assert.equal(warm.records.size,0);
    firstCheck.resolve(revokedAt!==1);
    if(revokedAt!==1){
      await lastRequested.promise;
      assert.equal(indexReads,1);
      assert.equal(warm.records.size,0,'a validated delta is still withheld until the final live check');
      lastCheck.resolve(revokedAt!==2);
    }
    await result;
    assert.equal(checks,revokedAt===1?1:2);
    assert.equal(warm.records.size,revokedAt?0:6);
    assert.equal(signal.aborted,revokedAt===1);
  }finally{firstCheck.resolve(false);lastCheck.resolve(false);x.close();}
});
test('damaged or absent derived cache falls back to the ordinary verified snapshot',async()=>{
  const x=await setup(12);try{
    const [key,packet]=[...x.cache.indexes][0];packet.envelope.ciphertext=packet.envelope.ciphertext.replace(/^./,c=>c==='A'?'B':'A');x.cache.indexes.set(key,packet);
    const counts=await countCrypto(async()=>{await x.warm.sync();});assert.equal(counts.verify,12);
    await x.warm.ensureList(new URLSearchParams({limit:'1'}));assert.equal(x.warm.list(new URLSearchParams({limit:'1'})).entries[0].id,12);
  }finally{x.close();}
});
test('a sealed index cannot authorize changed ciphertext, replay or changed actor permissions',async()=>{
  const x=await setup(12);try{
    const [key,snapshot]=[...x.cache.snapshots][0];
    snapshot.records[0].attestation.signature=snapshot.records[0].attestation.signature.replace(/^./,c=>c==='A'?'B':'A');
    x.cache.snapshots.set(key,snapshot);
    const native=x.writer.transport.snapshot;
    x.warm.transport={...x.writer.transport,snapshot:async(h,since)=>{const current=await native(h,since);return since<0?{...current,records:snapshot.records}:current;}};
    await assert.rejects(x.warm.sync(),/InvalidSignature/);assert.equal(x.warm.records.size,0);
    x.warm.transport=x.writer.transport;
    x.cache.snapshots.set(key,await x.writer.transport.snapshot('A',-1));
    const changed=await x.create({...x.writer.actor,canViewTrash:false});
    try{const counts=await countCrypto(()=>changed.sync());assert.equal(counts.verify,12,'current actor permissions invalidate the cached verification context');}finally{changed.lock();}
    x.warm.lock();await x.warm.unlock(new Uint8Array(prepared.secrets.ownerA.prf));
    x.cache.points.set([...x.cache.points.keys()][0],100000);
    await assert.rejects(x.warm.sync(),/RollbackDetected/);assert.equal(x.warm.records.size,0);
  }finally{x.close();}
});
test('a truncated local snapshot is refreshed instead of silently losing articles',async()=>{
  const x=await setup();try{
    const [key,snapshot]=[...x.cache.snapshots][0];snapshot.records.pop();x.cache.snapshots.set(key,snapshot);
    let fullReads=0;const native=x.writer.transport.snapshot;
    x.warm.transport={...x.writer.transport,snapshot:async(h,since)=>{if(since===-1)fullReads++;return native(h,since);}};
    await x.warm.sync();assert.equal(fullReads,1);assert.equal(x.warm.records.size,24);
  }finally{x.close();}
});
test('a sealed derived index is bound to its household and the complete current directory',async()=>{
  const x=await setup();try{
    const [key,snapshot]=[...x.cache.snapshots][0],profile=x.warm.profile,directory=x.warm.directory;
    x.warm.profile={...profile,household:'B'};assert.equal(await x.warm.readPreparedIndex(key,snapshot),false);
    x.warm.profile=profile;x.warm.directory={...directory,generation:directory.generation+1};
    assert.equal(await x.warm.readPreparedIndex(key,snapshot),false);x.warm.directory=directory;
  }finally{x.close();}
});
test('a live session rejection prevents any cached index from being published',async()=>{
  const x=await setup();try{
    x.warm.transport={...x.warm.transport,valid:async()=>false};
    await assert.rejects(x.warm.sync(),/SessionExpired/);assert.equal(x.warm.closed,true);assert.equal(x.warm.records.size,0);
  }finally{x.close();}
});
test('logout interrupts deferred signature/decryption and optional index storage cannot reopen a diary',async()=>{
  const x=await setup();const native=crypto.subtle.verify;let release,entered;
  const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  try{
    await x.warm.sync();crypto.subtle.verify=async function(...args){entered();await gate;return native.apply(this,args);};
    const pending=x.warm.hydrate('24');await started;x.warm.lock();release();await assert.rejects(pending,/SessionExpired|SessionChanged/);
    assert.equal(x.warm.records.size,0);assert.equal(x.warm.indexCacheState,null);assert.equal(x.warm.keys.size,0);
  }finally{release();crypto.subtle.verify=native;x.close();}
});
test('an unavailable derived-index store preserves foreground and background diary use',async()=>{
  const x=await setup();try{
    x.cache.indexes.clear();x.cache.putIndex=async()=>{throw new Error('QuotaExceededError');};
    await x.warm.sync();await x.warm.ensureList(new URLSearchParams({limit:'3'}));await x.warm.startBackground();
    assert.equal(x.warm.closed,false);assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,24);
  }finally{x.close();}
});
test('background crypto waits for the view readiness signal while foreground entries remain usable',async()=>{
  const x=await setup();let present,entered;
  const gate=new Promise(r=>{present=r;}),waiting=new Promise(r=>{entered=r;});
  try{
    await x.warm.sync();await x.warm.ensureList(new URLSearchParams({limit:'3'}));
    x.warm.transport={...x.warm.transport,backgroundReady:()=>{entered();return gate;}};
    const background=x.warm.startBackground();await waiting;
    assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,3);
    assert.equal(x.warm.list(new URLSearchParams({limit:'3'})).entries.length,3);
    present();await background;assert.equal([...x.warm.records.values()].filter(r=>r.entry).length,24);
  }finally{present();x.close();}
});
test('a late optional index write uses its fixed record set across an in-place foreground commit',async()=>{
  const x=await setup();let resumed;
  try{
    x.cache.indexes.clear();await x.warm.sync();
    await x.warm.commit(entry({entryDate:'2035-01-01'}),{id:'100'},{refresh:false});
    await x.warm.persistPreparedIndex();x.warm.lock();resumed=await x.create();
    const native=x.writer.transport.snapshot;let full=0;
    resumed.transport={...x.writer.transport,snapshot:async(h,since)=>{if(since===-1)full++;return native(h,since);}};
    await resumed.sync();assert.equal(full,0);assert.equal(resumed.records.size,25);
  }finally{resumed?.lock();x.close();}
});
test('an unchanged durable snapshot remains reusable when parallel verification finishes in a different order',async()=>{
  const x=await setup();let resumed,release;
  try{
    x.cache.indexes.clear();
    const firstId=[...x.cache.snapshots.values()][0].records[0].id,native=x.warm.indexRecord.bind(x.warm);
    const gate=new Promise(r=>{release=r;});
    x.warm.indexRecord=async(...args)=>{const result=await native(...args);if(args[0].id===firstId){await gate;await new Promise(r=>setTimeout(r,0));}else release();return result;};
    await x.warm.sync();assert.notEqual([...x.warm.records.keys()][0],firstId);
    await x.warm.persistPreparedIndex();resumed=await x.create();
    const counts=await countCrypto(()=>resumed.sync());assert.equal(counts.verify,0);assert.equal(resumed.records.size,24);
  }finally{release?.();resumed?.lock();x.close();}
});
