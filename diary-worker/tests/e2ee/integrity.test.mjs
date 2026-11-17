import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {provision,fixture,entry} from './fixture.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {createEncryptedDiaryApi} from '../../e2ee/ui-api.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
let prepared;before(async()=>{prepared=await provision();});

test('a stale edit draft remains saveable without permitting stale publication or a forged new source',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA'),b=await f.client('editorA');
  const source=(await a.saveEntry(entry())).entry;
  const draft=(await a.saveEntry({...source,status:'draft',title:'Synthetic draft'},String(source.id))).entry;
  await b.sync();await b.saveEntry({...b.entry(source.id),title:'Synthetic other device'},String(source.id));
  const saved=(await a.saveEntry({...draft,title:'Synthetic continued draft',status:'draft'},String(draft.id))).entry;
  assert.equal(saved.title,'Synthetic continued draft');assert.equal(saved.draftOfRevision,source.revision);
  await assert.rejects(a.saveEntry({...saved,status:'published'},String(saved.id)),{status:409});
  assert.equal(a.entry(source.id).title,'Synthetic other device');
  const forged=await a.prepare(entry(),{state:'draft',sourceId:String(source.id),sourceRevision:source.revision});
  await assert.rejects(f.store.mutation(f.actors.ownerA,forged),/InvalidDraftSource/);
  await b.transition(source.id,'trash',b.entry(source.id).revision);
  const continued=(await a.saveEntry({...saved,status:'draft',content:'Synthetic retained input'},String(saved.id))).entry;
  assert.equal(continued.content,'Synthetic retained input');
 }finally{f.close();}
});

test('trash records carry encrypted deletion attribution and restore clears it',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA'),b=await f.client('editorA'),value=(await a.saveEntry(entry())).entry;
  await a.transition(value.id,'trash',value.revision);let row=a.entry(value.id);
  assert.ok(Number.isFinite(Date.parse(row.deletedAt)));assert.equal(row.deletedById,'ownerA');assert.equal(row.deletedByName,a.profile.displayName);
  await a.transition(value.id,'restore');row=a.entry(value.id);assert.equal(row.deletedAt,null);assert.equal(row.deletedByName,null);
  await b.sync();await b.transition(value.id,'trash',b.entry(value.id).revision);await a.sync();row=a.entry(value.id);
  assert.equal(row.deletedById,'editorA');assert.equal(row.deletedByName,b.profile.displayName);
  assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes(row.deletedByName),false);
 }finally{f.close();}
});

test('foreground list/detail/meta reads synchronize other-device changes and enforce revocation',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA'),b=await f.client('editorA');
  const api=createEncryptedDiaryApi(a,{session:{authenticated:true},nativeApi:async()=>({households:[]})});
  await api('/bootstrap');const value=(await b.saveEntry(entry({title:'Synthetic external post',tags:['Synthetic external tag']}))).entry;
  const result=await api('/entries?q=Synthetic%20external');assert.equal(result.entries[0].id,value.id);
  await b.saveEntry({...b.entry(value.id),title:'Synthetic updated title'},String(value.id));
  assert.equal((await api(`/entries/${value.id}`)).entry.title,'Synthetic updated title');
  assert.equal((await api('/meta')).tags[0].value,'Synthetic external tag');
  f.actors.ownerA.active=false;await assert.rejects(api('/entries'),{status:401});assert.equal(a.records.size,0);
 }finally{f.close();}
});

test('album counts use verified summaries and album pages hydrate only published documents once',async()=>{
 const f=await fixture(prepared);try{
  const writer=await f.client('ownerA');
  for(let i=1;i<=3;i++){const id=crypto.randomUUID();f.registry.photos[id]={household:'A',accountId:'ownerA'};await writer.commit(entry({photos:[{id,fileName:`synthetic-${i}.jpg`}]}),{id:String(i)},{refresh:false});}
  await writer.commit(entry(),{id:'4',state:'draft'},{refresh:false});
  await writer.commit(entry(),{id:'5'},{refresh:false});await writer.transition('5','trash',1);
  const reader=new EncryptedDiaryClient({transport:writer.transport,profile:writer.profile,anchor:prepared.anchor,lazy:true});
  await reader.unlock(new Uint8Array(prepared.secrets.ownerA.prf));reader.startBackground=()=>{};
  const api=createEncryptedDiaryApi(reader,{session:{authenticated:true},nativeApi:async()=>({households:[]})});
  assert.equal((await api('/photos/meta')).months[0].count,3);
  assert.equal([...reader.records.values()].filter(r=>r.entry).length,0);
  let entries=0;const native=reader.entry.bind(reader);reader.entry=(...args)=>{entries++;return native(...args);};
  assert.equal((await api('/photos?limit=1')).photos.length,1);assert.equal(entries,3);
  assert.equal((await api('/photos?offset=1&limit=1')).photos.length,1);assert.equal(entries,3,'unchanged pages reuse the sorted album');
  assert.equal(reader.records.get('4').entry,undefined);assert.equal(reader.records.get('5').entry,undefined);
  reader.lock();assert.equal(reader.albumCache,null);writer.lock();
 }finally{f.close();}
});

test('an ordinary save reduces repeated checks while retaining live checks before and after network mutation',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA'),value=(await a.saveEntry(entry())).entry,calls=[];
  for(const name of ['valid','snapshot','timestamp','mutation']){const native=a.transport[name];a.transport[name]=async(...args)=>{calls.push(name);return native(...args);};}
  await a.saveEntry({...value,title:'Synthetic edit'},String(value.id));
  assert.equal(calls.filter(n=>n==='valid').length,4);assert.equal(calls.length,8);assert.equal(calls.filter(n=>n==='mutation').length,1);
  const native=a.transport.mutation;a.transport.mutation=async(...args)=>{const result=await native(...args);f.actors.ownerA.active=false;return result;};
  await assert.rejects(a.saveEntry({...a.entry(value.id),title:'Synthetic revoked'},String(value.id)),{status:401});assert.equal(a.records.size,0);
 }finally{f.close();}
});

test('create request identity survives lost receipts and a fresh client without duplicates or cross-account reuse',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA'),requestId=crypto.randomUUID(),body={...entry(),requestId,status:'draft'},native=a.transport.mutation;
  a.transport.mutation=async(...args)=>{await native(...args);throw new Error('Synthetic lost receipt');};
  await assert.rejects(a.saveEntry(body),/Synthetic lost receipt/);a.lock();
  const b=await f.client('ownerA'),saved=(await b.saveEntry(body)).entry;
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_e2ee_records').get().count,1);
  assert.equal((await b.saveEntry(body)).entry.id,saved.id);
  await assert.rejects(b.saveEntry({...body,title:'Changed creation intent'}),{status:409});
  const other=await f.client('editorA');assert.notEqual((await other.saveEntry(body)).entry.id,saved.id);
  const home=await f.client('ownerA','B');assert.notEqual((await home.saveEntry(body)).entry.id,saved.id);
 }finally{f.close();}
});

test('cold snapshot pages prepare verified summaries during transfer without exposing a partial index',async()=>{
 const f=await fixture(prepared);try{
  const writer=await f.client('ownerA');for(let i=1;i<=4;i++)await writer.commit(entry(),{id:String(i)},{refresh:false});
  const head=await f.store.snapshotHead(f.actors.ownerA,'A');head.pages=[{after:null,limit:2},{after:'2',limit:2}];
  let firstPrepared=false,reader;
  const transport={...writer.transport,snapshot:(h,since,{onPage}={})=>readSnapshotPages(async opts=>{
    if(opts.after==='2'){while(!firstPrepared)await new Promise(r=>setTimeout(r,0));assert.equal(reader.records.size,0);}
    return f.store.snapshotPage(f.actors.ownerA,h,opts);
  },h,since,{fetchHead:async()=>head,onPage:async(...args)=>{await onPage(...args);firstPrepared=true;}})};
  reader=new EncryptedDiaryClient({transport,profile:writer.profile,anchor:prepared.anchor,lazy:true});await reader.unlock(new Uint8Array(prepared.secrets.ownerA.prf));
  await reader.sync();assert.equal(firstPrepared,true);assert.equal(reader.records.size,4);assert.equal([...reader.records.values()].filter(r=>r.entry).length,0);reader.lock();
 }finally{f.close();}
});

test('the 5000-record boundary rejects a new record atomically, including concurrent creates, and allows edits',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA');
  // Signed records are installed directly only to prepare the large fixture;
  // the boundary writes below pass through the production store transaction.
  const insert=f.db.sqlite.prepare('INSERT INTO diary_e2ee_records(id,household,scope,state,author,revision,epoch,source_id,source_revision,retained_for,envelope,summary,photo_ids,request_id,mutation_id,key_box,attestation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let cursor=0;await Promise.all(Array.from({length:8},async()=>{while(cursor<4999){const id=String(++cursor),p=await a.prepare(entry(),{id}),r=a.preparedBindings.get(p);insert.run(id,r.household,r.scope,r.state,r.author,r.revision,r.epoch,r.sourceId,r.sourceRevision,JSON.stringify(r.retainedFor),JSON.stringify(p.envelope),JSON.stringify(p.summary),JSON.stringify(p.photoIds),p.requestId,p.requestId,JSON.stringify(p.keyBox),JSON.stringify(p.attestation));}}));
  const proposals=await Promise.all(['5000','5001'].map(id=>a.prepare(entry(),{id})));
  const results=await Promise.allSettled(proposals.map(p=>f.store.mutation(f.actors.ownerA,p)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,413);
  assert.equal((await f.store.snapshotHead(f.actors.ownerA,'A')).total,5000);
  await a.sync();const value=a.entry('1');assert.equal((await a.saveEntry({...value,title:'Synthetic edit at limit'},'1')).entry.title,'Synthetic edit at limit');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_e2ee_records').get().count,5000);
 }finally{f.close();}
});

test('the byte budget rejects an oversized next write and still permits shrinking an existing document',async()=>{
 const f=await fixture(prepared);try{
  const a=await f.client('ownerA'),large=entry({content:'合'.repeat(200000)});let rejected=false,last;
  for(let i=1;i<80;i++){
   try{last=await a.commit(large,{id:String(i)},{refresh:false});}
   catch(error){assert.equal(error.status,413);rejected=true;break;}
  }
  assert.equal(rejected,true);const before=await f.store.snapshotHead(f.actors.ownerA,'A');assert.ok(before.total>1);
  const row=a.records.get('1').row;
  await a.commit(entry({content:'Synthetic smaller document'}),{id:'1',current:row},{refresh:false});
  const p=await a.prepare(large,{id:'999'});await f.store.mutation(f.actors.ownerA,p);
  assert.equal((await f.store.snapshotHead(f.actors.ownerA,'A')).total,before.total+1);
 }finally{f.close();}
});

test('logout during write encryption cannot repopulate pending operations or send a late mutation',async()=>{
 const f=await fixture(prepared),encrypt=crypto.subtle.encrypt;let release,entered;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 try{
  const a=await f.client('ownerA');await a.sync();let mutations=0;const native=a.transport.mutation;a.transport.mutation=async(...args)=>{mutations++;return native(...args);};
  crypto.subtle.encrypt=async function(...args){entered();await gate;return encrypt.apply(this,args);};
  const pending=a.commit(entry());await started;a.lock();release();await assert.rejects(pending);assert.equal(mutations,0);assert.equal(a.pending.size,0);assert.equal(a.actions.size,0);assert.equal(a.records.size,0);
 }finally{release();crypto.subtle.encrypt=encrypt;f.close();}
});

test('a late session failure from an old household does not clear a newer household generation',async()=>{
 const f=await fixture(prepared);let release,entered;
 const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 try{
  const a=await f.client('ownerA'),keys=a.keys;
  a.transport.valid=async()=>{entered();await gate;return false;};
  const pending=a.check();await started;a.generation++;a.profile={...a.profile,household:'B'};release();
  await assert.rejects(pending,/SessionChanged/);assert.equal(a.closed,false);assert.equal(a.keys,keys);assert.ok(a.keys.size>0);a.lock();
 }finally{release();f.close();}
});
