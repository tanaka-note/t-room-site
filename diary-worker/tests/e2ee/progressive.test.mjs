import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {fixture,provision,entry} from './fixture.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {createEncryptedDiaryApi} from '../../e2ee/ui-api.mjs';
import {signed,unb64} from '../../e2ee/crypto.mjs';
import {proofOf} from '../../e2ee/record.mjs';

let prepared;before(async()=>{prepared=await provision();});
async function setup(count=48) {
  const f=await fixture(prepared),writer=await f.client('ownerA');writer.documentFormat=2;
  const photo={id:crypto.randomUUID(),fileName:'synthetic-private-photo.jpg',contentType:'image/jpeg',originalSize:1234};f.registry.photos[photo.id]={household:'A',accountId:'ownerA'};
  for(let i=0;i<count;i++)await writer.commit(entry({entryDate:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),title:`Synthetic ${i}`,content:i===0?'OLDEST_UNIQUE_CANARY':`Private body ${i}`,photos:i===0?[photo]:[]}),{id:String(i+1)},{refresh:false});
  const reader=new EncryptedDiaryClient({transport:writer.transport,profile:writer.profile,anchor:prepared.anchor,lazy:true});
  await reader.unlock(new Uint8Array(prepared.secrets.ownerA.prf));
  return {f,writer,reader,close:()=>{writer.lock();reader.lock();f.close();}};
}
test('verified summaries build the complete index; the first page decrypts only its documents',async()=>{
  const x=await setup();try {
    await x.reader.sync();assert.equal(x.reader.records.size,48);
    assert.equal([...x.reader.records.values()].filter(r=>r.entry).length,0);
    const p=new URLSearchParams({limit:'5'});await x.reader.ensureList(p);
    const result=x.reader.list(p);assert.equal(result.entries[0].title,'Synthetic 47');assert.equal(result.entries.length,5);assert.equal(result.hasMore,true);
    assert.equal([...x.reader.records.values()].filter(r=>r.entry).length,5);
    assert.equal(x.reader.meta().months.reduce((n,m)=>n+m.count,0),48);
    await x.reader.startBackground();assert.equal([...x.reader.records.values()].filter(r=>r.entry).length,48);
  }finally{x.close();}
});
test('concurrent initial synchronization shares one verified snapshot',async()=>{
  const x=await setup(3);try {
    let count=0;const native=x.reader.transport.snapshot;x.reader.transport.snapshot=async(...args)=>{count++;return native(...args);};
    const first=x.reader.sync(),second=x.reader.sync();assert.equal(first,second);await Promise.all([first,second]);assert.equal(count,1);assert.equal(x.reader.records.size,3);
  }finally{x.close();}
});
test('full-text search waits for all relevant bodies and finds the oldest unprepared document',async()=>{
  const x=await setup();try {
    await x.reader.sync();const p=new URLSearchParams({q:'OLDEST_UNIQUE_CANARY'});await x.reader.ensureList(p);
    assert.deepEqual(x.reader.list(p).entries.map(e=>e.id),[1]);
  }finally{x.close();}
});
test('same-day ordering, unloaded edits, author and photo metadata survive lazy loading',async()=>{
  const x=await setup(3);try {
    const photos=x.writer.records.get('1').entry.photos;
    for(const [i,t] of [[1,'01'],[2,'03'],[3,'02']])await x.writer.commit(entry({entryDate:'2026-01-01',lastPublishedAt:`2026-01-01T${t}:00:00Z`,photos:i===1?photos:[],content:`Body ${i}`}),{id:String(i),current:x.writer.records.get(String(i)).row},{refresh:false});
    await x.reader.sync();const p=new URLSearchParams({limit:'1'});await x.reader.ensureList(p);assert.equal(x.reader.list(p).entries[0].id,2);
    x.reader.lock();await x.reader.unlock(new Uint8Array(prepared.secrets.ownerA.prf));await x.reader.sync();
    const saved=await x.reader.saveEntry({...entry(),title:'Edited',revision:2},'1');assert.equal(saved.entry.title,'Edited');assert.equal(saved.entry.authorName,entry().authorName);
    assert.equal(saved.entry.authorId,'ownerA');
    assert.deepEqual(saved.entry.photos,photos);
  }finally{x.close();}
});
test('favorites, edit-draft publishing and trash/restore hydrate targets without losing other documents',async()=>{
  const x=await setup(3);try {
    await x.reader.sync();await x.reader.setFavorite('2',true);assert.equal(x.reader.entry('2').isFavorite,true);
    const draft=(await x.reader.saveEntry({...entry(),title:'Draft edit',status:'draft',revision:1},'3')).entry;
    const published=(await x.reader.saveEntry({...draft,status:'published'},String(draft.id))).entry;
    assert.equal(published.id,3);assert.equal(published.authorId,'ownerA');
    await x.reader.transition('3','trash',published.revision);assert.equal(x.reader.records.get('3').row.state,'trash');
    await x.reader.transition('3','restore',x.reader.records.get('3').row.revision);assert.equal(x.reader.records.get('3').row.state,'published');
    await x.reader.ensureAll();assert.equal(x.reader.entry('1').photos.length,1);assert.equal(x.reader.entry('2').isFavorite,true);
  }finally{x.close();}
});
test('invalid signatures reject the index; deferred document corruption rejects search instead of returning no matches',async()=>{
  const x=await setup(3);try {
    const snapshot=await x.reader.transport.snapshot('A',-1),native=x.reader.transport.snapshot;
    const corrupt=structuredClone(snapshot);corrupt.records[0].attestation.signature=corrupt.records[0].attestation.signature.replace(/^./,v=>v==='A'?'B':'A');
    x.reader.transport.snapshot=async()=>corrupt;await assert.rejects(x.reader.sync(),/InvalidSignature/);assert.equal(x.reader.records.size,0);
    const row=structuredClone(snapshot.records[0]);row.envelope.ciphertext=row.envelope.ciphertext.replace(/^./,v=>v==='A'?'B':'A');
    row.attestation.signature=(await signed(proofOf(row),x.writer.privateKeys.sign)).signature;
    x.reader.transport.snapshot=async()=>({...snapshot,records:[row,...snapshot.records.slice(1)]});await x.reader.sync();
    await assert.rejects(x.reader.ensureList(new URLSearchParams({q:'missing'})));
    x.reader.transport.snapshot=native;
  }finally{x.close();}
});
test('logout cancels pending decryption and never repopulates cleared records',async()=>{
  const x=await setup(3);const decrypt=crypto.subtle.decrypt;let release,started;
  const gate=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;});
  try {
    await x.reader.sync();crypto.subtle.decrypt=async function(...args){started();await gate;return decrypt.apply(this,args);};
    const pending=x.reader.hydrate('1');await entered;x.reader.lock();release();await assert.rejects(pending,/SessionChanged/);assert.equal(x.reader.records.size,0);assert.equal(x.reader.keys.size,0);assert.equal(x.reader.privateKeys,null);
  }finally{release();crypto.subtle.decrypt=decrypt;x.close();}
});
test('one bootstrap sync, complete album data and unchanged ciphertext cache reuse',async()=>{
  const x=await setup();try {
    let snapshots=0,writes=0;const values=new Map(),native=x.reader.transport.snapshot;
    x.reader.cache={get:async k=>values.get(k),put:async(k,v)=>{writes++;values.set(k,structuredClone(v));}};
    x.reader.transport.snapshot=async(...args)=>{snapshots++;return native(...args);};
    const api=createEncryptedDiaryApi(x.reader,{session:{authenticated:true},nativeApi:async()=>({households:[]})});
    const result=await api('/bootstrap?limit=5');assert.equal(result.entries.entries.length,5);assert.equal(snapshots,1);assert.equal(writes,1);
    const album=await api('/photos');assert.equal(album.photos.length,1);assert.equal(album.photos[0].fileName,'synthetic-private-photo.jpg');assert.equal([...x.reader.records.values()].filter(r=>r.entry).length,48);
    await x.reader.startBackground();x.reader.lock();await x.reader.unlock(new Uint8Array(prepared.secrets.ownerA.prf));await x.reader.sync();assert.equal(writes,1,'unchanged cache is not rewritten');
  }finally{x.close();}
});
test('a valid deletion delta during background decryption does not lock the current session',async()=>{
  const x=await setup(3),decrypt=crypto.subtle.decrypt;let release,started;
  const gate=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;});
  try {
    await x.reader.sync();const iv=unb64(x.reader.records.get('1').row.envelope.iv),errors=[];
    crypto.subtle.decrypt=async function(algorithm,...args){if(algorithm.iv&&new Uint8Array(algorithm.iv).every((v,i)=>v===iv[i])){started();await gate;}return decrypt.call(this,algorithm,...args);};
    x.reader.onBackgroundError=error=>errors.push(error.message);const background=x.reader.startBackground();await entered;
    const before=x.reader.sequence;x.reader.transport.snapshot=async()=>({version:1,household:'A',sequence:before+1,baseSequence:before,delta:true,unchanged:false,records:[],removed:['1']});
    await x.reader.sync();release();await background;assert.deepEqual(errors,[]);assert.equal(x.reader.closed,false);assert.equal(x.reader.records.size,2);
  }finally{release();crypto.subtle.decrypt=decrypt;x.close();}
});
