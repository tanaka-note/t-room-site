import assert from 'node:assert/strict';
import {before,test} from 'node:test';
import {fixture,provision,entry} from './fixture.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {createEncryptedDiaryApi} from '../../e2ee/ui-api.mjs';
import {signed,unb64} from '../../e2ee/crypto.mjs';
import {proofOf} from '../../e2ee/record.mjs';
import {createPrivateNavigation} from '../../e2ee/privacy.mjs';
import {LARGE_SNAPSHOT_PAGE_SIZE,readSnapshotPages} from '../../e2ee/snapshot.mjs';

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
test('an interrupted startup releases a stalled cache read and retries without accepting its late result', async () => {
  const x = await setup(3);
  try {
    const started = Promise.withResolvers(), heldCache = Promise.withResolvers();
    let cacheReads = 0, snapshots = 0;
    x.reader.cache = {
      readStartup: () => {
        if (++cacheReads > 1) return {};
        started.resolve();
        return heldCache.promise;
      },
      put: async () => {},
    };
    const transport = x.reader.transport;
    const snapshot = transport.snapshot.bind(transport);
    transport.snapshot = (...args) => {
      snapshots++;
      return snapshot(...args);
    };
    const api = createEncryptedDiaryApi(x.reader, {
      session: {authenticated: true},
      nativeApi: async () => ({households: []}),
    });
    const controller = new AbortController();
    const pending = api('/bootstrap?limit=3', {signal: controller.signal});
    await started.promise;
    controller.abort(new DOMException('Deadline reached', 'TimeoutError'));
    await assert.rejects(pending, {name: 'TimeoutError'});
    assert.equal(snapshots, 0);
    assert.equal(x.reader.closed, false);

    const retry = await api('/bootstrap?limit=3');
    assert.equal(retry.entries.entries.length, 3);
    assert.equal(cacheReads, 2);
    heldCache.resolve({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshots, 1, 'the stopped read cannot resume against the live session');
  } finally {
    x.close();
  }
});
test('larger fixed startup pages reduce reads while the old reader, size budget and sequence rules still work',async()=>{
  const x=await setup(112);
  try {
    const {store,actors,db}=x.f,actor=actors.ownerA;
    const fetchWith=async pageLimit=>{
      const sizes=[];
      const reply=await readSnapshotPages(options=>{
        sizes.push(options.limit);
        return store.snapshotPage(actor,'A',options);
      },'A',-1,{pageLimit,fetchHead:()=>store.snapshotHead(actor,'A',pageLimit===50?undefined:{pageLimit})});
      return {sizes,reply};
    };
    const old=await fetchWith(50),wide=await fetchWith(LARGE_SNAPSHOT_PAGE_SIZE);
    assert.deepEqual(old.sizes,[50,50,12]);
    assert.deepEqual(wide.sizes,[100,12]);
    assert.deepEqual(wide.reply,old.reply);
    const at=wide.reply.sequence;
    await assert.rejects(store.snapshotPage(actor,'A',{limit:100}),{status:400});
    await assert.rejects(store.snapshotPage(actor,'A',{since:0,at,limit:100}),{status:400});
    await assert.rejects(store.snapshotPage(actor,'A',{at:at-1,limit:100}),/SnapshotChanged/);
    await assert.rejects(store.snapshotHead(actor,'A',{pageLimit:101}),{status:400});
    // Only the byte-count guard is under test here. Inflate SQLite's encrypted
    // envelopes directly so this case cannot be accepted as a signed document.
    await db.prepare('UPDATE diary_e2ee_records SET envelope=?').bind(JSON.stringify({ciphertext:'A'.repeat(20000)})).run();
    const limited=await store.snapshotHead(actor,'A',{pageLimit:100});
    assert.ok(limited.pages.every(page=>page.limit<50));
    await assert.rejects(store.snapshotPage(actor,'A',{at:limited.sequence,limit:100}),{status:413});
  }finally{x.close();}
});
test('a legacy bookmarked tag resolves before the index and becomes an encrypted route afterward',async()=>{
  const x=await setup(3),savedLocation=globalThis.location,tag=entry().tags[0];let navigation;
  try {
    globalThis.location={pathname:'/diary/tag/'+encodeURIComponent(tag)+'/'};
    const storage={length:0,getItem:()=>null,removeItem:()=>{}},history={state:{},replaceState:(_state,_title,url)=>{globalThis.location.pathname=url;}};
    navigation=await createPrivateNavigation(x.reader,{storage,history});
    assert.equal(x.reader.records.size,0);assert.equal(navigation.tagValue(encodeURIComponent(tag)),tag);
    await x.reader.sync();await navigation.prepareTags();const segment=globalThis.location.pathname.split('/')[3];
    assert.ok(segment.startsWith('e_'));assert.equal(navigation.tagValue(segment),tag);
  }finally{navigation?.close();if(savedLocation===undefined)delete globalThis.location;else globalThis.location=savedLocation;x.close();}
});
test('full-text search waits for all relevant bodies and finds the oldest unprepared document',async()=>{
  const x=await setup();try {
    await x.reader.sync();const p=new URLSearchParams({q:'OLDEST_UNIQUE_CANARY'});await x.reader.ensureList(p);
    assert.deepEqual(x.reader.list(p).entries.map(e=>e.id),[1]);
  }finally{x.close();}
});
test("date search hydrates and pages in the selected order", async () => {
  const x = await setup(4);
  try {
    const previous = x.writer.records.get("4").row;
    await x.writer.commit(entry({ entryDate: "2026-01-02", title: "Synthetic same day", lastPublishedAt: "2026-01-02T00:00:00Z" }),
      { id: "4", current: previous }, { refresh: false });
    await x.reader.sync();
    const params = new URLSearchParams({ dateFrom: "2026-01-01", dateTo: "2026-01-03", limit: "2", order: "oldest" });
    await x.reader.ensureList(params);
    assert.deepEqual([...x.reader.records.values()].filter(record => record.entry).map(record => record.row.id).sort(), ["1", "2", "4"]);
    const first = x.reader.list(params);
    assert.deepEqual(first.entries.map(e => e.id), [1, 4]);
    assert.equal(first.entries[0].content, "OLDEST_UNIQUE_CANARY");
    assert.equal(first.hasMore, true);
    params.set("offset", "2");
    await x.reader.ensureList(params);
    assert.deepEqual(x.reader.list(params).entries.map(e => e.id), [2, 3]);
    params.delete("offset");
    params.set("q", "Synthetic");
    params.set("order", "newest");
    await x.reader.ensureList(params);
    assert.deepEqual(x.reader.list(params).entries.map(e => e.id), [3, 2]);
  } finally {
    x.close();
  }
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
    const album=await api('/photos');assert.equal(album.photos.length,1);assert.equal(album.photos[0].fileName,'synthetic-private-photo.jpg');
    await x.reader.startBackground();x.reader.lock();await x.reader.unlock(new Uint8Array(prepared.secrets.ownerA.prf));await x.reader.sync();assert.equal(writes,1,'unchanged cache is not rewritten');
  }finally{x.close();}
});
test('album hydrates the requested days and retains the full-list order across pages', async () => {
  const x = await setup(8);
  try {
    const photo = (fileName) => {
      const id = crypto.randomUUID();
      x.f.registry.photos[id] = {household:'A', accountId:'ownerA'};
      return {id, fileName, contentType:'image/jpeg', originalSize:1234};
    };
    const [first, second, later, latest] = ['first', 'second', 'later', 'latest'].map(photo);
    for (const [id, date, hour, photos] of [
      [2, '2026-01-05', '09', [first, second]],
      [3, '2026-01-05', '20', [later]],
      [4, '2026-02-01', '12', [latest]]
    ]) {
      await x.writer.commit(entry({entryDate:date, lastPublishedAt:date+'T'+hour+':00:00Z',
        photos, content:photos.map(({id}) => `[[写真:${id}]]`).join('\n')}),
        {id:String(id), current:x.writer.records.get(String(id)).row}, {refresh:false});
    }
    const api = createEncryptedDiaryApi(x.reader, {session:{authenticated:true}});
    const ids = result => result.photos.map(photo => photo.id);
    const preparedIds = () => [...x.reader.records.values()].filter(record => record.entry).map(record => record.row.id);
    const firstPage = await api('/photos?limit=1');
    assert.deepEqual(ids(firstPage), [latest.id]);
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(preparedIds(), ['4']);

    const tiePage = await api('/photos?limit=2&offset=2');
    assert.deepEqual(ids(tiePage), [second.id, first.id]);
    assert.equal(tiePage.hasMore, true);
    assert.deepEqual(preparedIds().sort(), ['2','3','4']);
    const monthPage = await api('/photos?month=2026-01&order=oldest&limit=3&offset=1');
    assert.deepEqual(ids(monthPage), [first.id, second.id, later.id]);
    assert.equal(monthPage.hasMore, false);

    const full = await api('/photos');
    assert.deepEqual(ids(full).slice(0, 4), [latest.id, later.id, second.id, first.id]);
    assert.deepEqual(ids(await api('/photos?entryQuery=OLDEST_UNIQUE_CANARY')), [full.photos.at(-1).id]);
    assert.deepEqual(ids(await api('/photos/save-list?dateFrom=2026-01-05&dateTo=2026-01-05')), [first.id, second.id, later.id]);
  } finally {
    x.close();
  }
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
