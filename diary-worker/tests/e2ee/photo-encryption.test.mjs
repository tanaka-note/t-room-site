import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {encryptPhotoParts,decryptPhotoPart,photoHeader,PHOTO_PREFIX} from '../../e2ee/photo-crypto.mjs';
import {createEncryptedMediaClient} from '../../e2ee/media-client.mjs';
import {PHOTO_CONTEXT_HEADER, PHOTO_FORMAT_HEADER, photoReadContext} from '../../e2ee/session.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {createStore} from '../../e2ee/store.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {systemFixture} from './system-fixture.mjs';

const kinds=['original','display','thumbnail'],household='tanaka-household';
const parts=()=>Object.fromEntries(kinds.map(kind=>[kind,new File([`PRIVATE_${kind}`],kind+'.jpg',{type:'image/jpeg'})]));
test('binary encryption authenticates every variant, ID, household and byte, including large originals',async()=>{
  const id=crypto.randomUUID(),plain=parts();plain.original=new Blob([new Uint8Array(8*1024*1024).fill(71)],{type:'image/jpeg'});
  const a=await encryptPhotoParts(plain,household,id),b=await encryptPhotoParts(plain,household,id);
  assert.notEqual(a.descriptor.key,b.descriptor.key);
  for(const kind of kinds){
    const bytes=new Uint8Array(await a.parts[kind].arrayBuffer());assert.ok(photoHeader(bytes));
    assert.deepEqual(await (await decryptPhotoPart(bytes,a.descriptor,household,id,kind)).arrayBuffer(),await plain[kind].arrayBuffer());
    for(const [h,p,k] of [['other',id,kind],[household,crypto.randomUUID(),kind],[household,id,kind==='original'?'display':'original']])await assert.rejects(decryptPhotoPart(bytes,a.descriptor,h,p,k));
    bytes[bytes.length-1]^=1;await assert.rejects(decryptPhotoPart(bytes,a.descriptor,household,id,kind));
  }
});

test('real upload adapter: mixed photos, immutable legacy objects, retries, old staging fences, settings and cache isolation',async()=>{
  const f=await systemFixture();globalThis.location=new URL(f.env.DIARY_ENCRYPTION_ORIGIN);
  let account='main-admin',cookieOverride,puts=0,reads=0,bodies=0,loseReply=false,holdReply,badContext=false;
  const requests=[];
  const put=f.env.MEDIA.put,get=f.env.MEDIA.get;
  f.env.MEDIA.put=async(...args)=>{puts++;return put(...args);};
  f.env.MEDIA.get=async(...args)=>{reads++;const object=await get(...args);if(object?.body)bodies++;return object;};
  const call=async(path,init={})=>{
    const headers=new Headers(init.headers);headers.set('Cookie',cookieOverride||f.cookie(account));
    requests.push({path,headers});
    if(init.method&&init.method!=='GET'){headers.set('Origin',location.origin);headers.set('X-Diary-Request','1');}
    let body=init.body;if(body&&!(body instanceof FormData)&&typeof body!=='string'){headers.set('Content-Type','application/json');body=JSON.stringify(body);}
    return f.worker.fetch(new Request(new URL(path,location),{...init,headers,body}),f.env,f.ctx);
  };
  const request=async(path,init={})=>{const r=await call('/diary/api/encryption'+path,init),v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error),{status:r.status});return v;};
  const {profile,rollout}=await request('/profile');
  const signedSession=await (await call('/diary/api/session')).json();
  const context=await photoReadContext(signedSession.keySession,household,rollout.generation,profile.directory.value.generation);
  const client=new EncryptedDiaryClient({profile,anchor:f.configuration.anchor,transport:{valid:async()=>account==='main-admin'&&f.users[account].active,timestamp:async()=>new Date().toISOString(),snapshot:(h,s)=>readSnapshotPages(o=>request('/snapshot?'+new URLSearchParams(Object.entries(o).filter(([,v])=>v!=null))),h,s),mutation:(proposal,operation)=>request('/mutation',{method:'POST',body:{proposal,operation}})}});
  let media;
  // Exercise Workers' streaming-hash branch with Node's independent SHA-256.
  crypto.DigestStream=class extends WritableStream {constructor(algorithm){let resolve,reject;const digest=new Promise((a,b)=>{resolve=a;reject=b;}),hash=createHash(algorithm);super({write:chunk=>hash.update(chunk),close:()=>resolve(hash.digest()),abort:reject});this.digest=digest;}};
  try{
    await client.unlock(new Uint8Array(f.users[account].prf));await client.sync();
    const legacyId=crypto.randomUUID(),old={id:legacyId,fileName:'legacy.jpg',contentType:'image/jpeg',originalSize:17,originalUrl:`/diary/api/photos/${legacyId}/original`,displayUrl:`/diary/api/photos/${legacyId}/display`,thumbnailUrl:`/diary/api/photos/${legacyId}/thumbnail`};
    const oldKeys=kinds.map(k=>'diary/staging/old/'+k);
    for(const key of oldKeys)f.r2.set(key,{bytes:new TextEncoder().encode('LEGACY_UNCHANGED!')});
    f.db.sqlite.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(legacyId,household,account,'migrated','attached',...oldKeys,'{}',1,'legacy',Date.now()+86400000,null);
    const liveMutation=client.transport.mutation;
    // Seed the pre-cutover signed record using the pre-rollout store, as migration does.
    const oldStore=createStore(f.db,{households:client.directory.households,epochs:client.directory.epochs,directory:client.directory,photos:{[legacyId]:{household,accountId:account}}});
    client.transport.mutation=(proposal,operation)=>oldStore.mutation(client.actor,proposal,operation);
    const saved=await client.commitAction('seed-legacy',{entryDate:'2026-11-18',title:'mixed',content:`[[写真:${legacyId}]]`,tags:[],photos:[old]}, {state:'published'});
    client.transport.mutation=liveMutation;await client.sync();
    media=createEncryptedMediaClient(client,request,async(...args)=>{
      if(holdReply&&args[0].includes('/api/photos/'))return holdReply(args[1]?.signal);
      const r=await call(...args);
      if(loseReply&&r.ok&&args[1]?.method==='POST'){loseReply=false;throw new TypeError('Synthetic lost upload reply');}
      if(badContext&&r.ok&&args[0].includes('/api/photos/'))r.headers.set(PHOTO_CONTEXT_HEADER,'mismatch');
      return r;
    },{photoContext:()=>context});
    const session=(await media.api('/photo-upload-sessions','POST',{})).uploadSession.id,id=crypto.randomUUID(),form=new FormData();form.set('id',id);
    const plain=parts();for(const kind of kinds)form.set(kind,plain[kind]);
    const route=`/diary/api/photo-upload-sessions/${session}/photos`;
    loseReply=true;assert.equal((await media.fetch(route,{method:'POST',body:form})).status,500);
    assert.equal((await media.fetch(route,{method:'POST',body:form})).status,200);assert.equal(puts,3,'a lost reply reuses the identical ciphertext and performs only three R2 puts');
    const stored=f.db.sqlite.prepare('SELECT * FROM diary_e2ee_media WHERE id=?').get(id),altered=new FormData();
    altered.set('id',id);altered.set('epoch',String(stored.epoch));altered.set('metadata',stored.metadata);
    for(const kind of kinds){const value=new Uint8Array(f.r2.get(stored[`${kind}_key`]).bytes);if(kind==='original')value[value.length-1]^=1;altered.set(kind,new Blob([value],{type:'application/octet-stream'}),kind+'.bin');}
    assert.equal((await call(`/diary/api/encryption/uploads/${session}/photos`,{method:'POST',body:altered})).status,409,'same-size changed ciphertext is rejected while session is active');
    assert.equal(puts,3);
    const result=await media.api(`/photo-upload-sessions/${session}/commit`,'POST',{entryId:saved.id,photoIds:[id]});
    const photo=result.photos[0];assert.ok(photo.crypto);assert.equal(client.entry(saved.id).photos.length,2);
    const firstRead=requests.length;
    for(const kind of kinds){
      const blob=await media.read(photo,kind);assert.equal(await blob.text(),`PRIVATE_${kind}`);
      const legacy=await media.read(old,kind);assert.equal(await legacy.text(),'LEGACY_UNCHANGED!');
    }
    assert.equal(requests.length-firstRead,6,'one HTTP request per cold photo variant');
    assert.ok(requests.slice(firstRead).every(({path,headers})=>path.startsWith('/diary/api/photos/')&&headers.get(PHOTO_CONTEXT_HEADER)===context));
    for(const candidate of [photo,old]){
      const before={reads,bodies,requests:requests.length};
      const [one,two]=await Promise.all([media.read(candidate,'thumbnail'),media.read(candidate,'thumbnail')]);
      assert.equal(one,two,'simultaneous readers share the revalidated result');
      assert.equal(requests.length,before.requests+1);
      assert.equal(reads,before.reads+1);
      assert.equal(bodies,before.bodies,'a matching validator uses the memory blob after authorizing it');
      assert.ok(requests.at(-1).headers.has('If-None-Match'));
    }
    const oldThumb=f.r2.get(oldKeys[2]);
    f.r2.set(oldKeys[2],{bytes:new TextEncoder().encode('Updated legacy thumbnail')});
    assert.equal(await (await media.read(old,'thumbnail')).text(),'Updated legacy thumbnail');
    f.r2.set(oldKeys[2],oldThumb);

    const beforeWrongFormat=reads;
    const formatMismatch=await call(photo.thumbnailUrl,{headers:{[PHOTO_CONTEXT_HEADER]:context,[PHOTO_FORMAT_HEADER]:'legacy'}});
    assert.equal(formatMismatch.status,409);
    assert.equal(reads,beforeWrongFormat,'a stale photo format cannot fetch the other representation');
    badContext=true;
    await assert.rejects(media.read(photo,'original'),{message:'PhotoResponseMismatch',status:409});
    badContext=false;
    const original=await media.fetch(photo.originalUrl+'?download=1');assert.equal(await original.text(),'PRIVATE_original');assert.equal(original.headers.get('Content-Type'),'image/jpeg');
    const keys=f.db.sqlite.prepare('SELECT original_key,display_key,thumbnail_key FROM diary_e2ee_media WHERE id=?').get(id);
    for(const key of Object.values(keys)){assert.ok(key.startsWith(PHOTO_PREFIX));assert.ok(photoHeader(f.r2.get(key).bytes));}
    const dump=JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_media WHERE id=?').get(id));assert.ok(!dump.includes(photo.crypto.key));assert.ok(!dump.includes('PRIVATE_'));
    for(const key of oldKeys)assert.equal(new TextDecoder().decode(f.r2.get(key).bytes),'LEGACY_UNCHANGED!');
    // Same-size altered ciphertext cannot replace a successful upload on retry.
    const retry=new FormData();for(const [key,value] of form)retry.set(key,value);
    const encrypted=await encryptPhotoParts(plain,household,id);retry.set('epoch','1');retry.set('metadata',f.db.sqlite.prepare('SELECT metadata FROM diary_e2ee_media WHERE id=?').get(id).metadata);
    for(const kind of kinds)retry.set(kind,encrypted.parts[kind],kind+'.bin');
    assert.equal((await call('/diary/api/encryption/uploads/'+session+'/photos',{method:'POST',body:retry})).status,409);
    // A pre-cutover uncommitted plaintext photo cannot become a new attachment.
    const staged=crypto.randomUUID();f.db.sqlite.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(staged,household,account,session,'ready','old-original','old-display','old-thumbnail','{}',1,'old',Date.now()+86400000,null);
    await assert.rejects(client.attachPhotos(saved.id,[{...old,id:staged}]),e=>e.status===409);
    assert.equal((await call(`/diary/api/encryption/uploads/${session}/photos/${staged}`)).status,409);
    const newSession=(await media.api('/photo-upload-sessions','POST',{})).uploadSession.id;
    retry.set('id',crypto.randomUUID());for(const kind of kinds)retry.set(kind,new Blob([new Uint8Array(50)],{type:'application/octet-stream'}),kind+'.bin');
    assert.equal((await call(`/diary/api/encryption/uploads/${newSession}/photos`,{method:'POST',body:retry})).status,409);
    f.env.DIARY_PHOTO_ENCRYPTION_ENABLED='false';
    assert.equal((await call(`/diary/api/encryption/uploads/${newSession}/photos`,{method:'POST',body:retry})).status,409,'photo setting cannot turn mandatory encryption off');
    assert.equal((await media.fetch(`/diary/api/photo-upload-sessions/${newSession}`,{method:'DELETE'})).status,200);
    account='chiharu-admin';assert.equal((await call(photo.thumbnailUrl)).status,404);account='main-admin';
    const switched=await call('/diary/api/households/select',{method:'POST',body:{householdId:'chiharu-household'}});
    assert.equal(switched.status,200);
    cookieOverride=switched.headers.get('Set-Cookie').split(';',1)[0];
    const beforeDenied=reads;
    for(const candidate of [photo,old])await assert.rejects(media.read(candidate,'thumbnail'),{status:401});
    assert.equal(reads,beforeDenied,'a new household cookie does not authorize an old view or memory blob');

    cookieOverride=f.cookie(account,{...f.users[account],sessionId:crypto.randomUUID()});
    await assert.rejects(media.read(photo,'thumbnail'),{status:401});
    assert.equal(reads,beforeDenied,'another login with the same account and household is denied');
    cookieOverride=null;
    f.users[account].active=false;
    for(const candidate of [photo,old])await assert.rejects(media.read(candidate,'thumbnail'),{status:401});
    assert.equal(reads,beforeDenied,'revocation denies warm and cold image data before reading storage');
    f.users[account].active=true;

    const validReply=await call(photo.thumbnailUrl,{headers:{[PHOTO_CONTEXT_HEADER]:context,[PHOTO_FORMAT_HEADER]:'encrypted'}});
    let release,started,networkSignal;
    const pausePhoto=()=>{
      const entered=new Promise(resolve=>{started=resolve;});
      holdReply=signal=>{networkSignal=signal;started();return new Promise(resolve=>{release=resolve;});};
      return entered;
    };
    let entered=pausePhoto();
    const firstReader=new AbortController();
    const deferred=media.read(photo,'thumbnail',{signal:firstReader.signal});
    const otherReader=media.read(photo,'thumbnail');
    await entered;
    firstReader.abort();
    await assert.rejects(deferred,{name:'AbortError'});
    assert.equal(networkSignal.aborted,false,'another reader still needs the shared request');
    release(validReply);
    assert.equal(await (await otherReader).text(),'PRIVATE_thumbnail');

    const lateReply=await call(photo.thumbnailUrl,{headers:{[PHOTO_CONTEXT_HEADER]:context,[PHOTO_FORMAT_HEADER]:'encrypted'}});
    for(const response of [lateReply,new Response(null,{status:401})]) {
      entered=pausePhoto();
      const late=media.read(photo,'thumbnail');
      await entered;
      client.generation++;
      release(response);
      await assert.rejects(late,{name:'AbortError'});
      assert.equal(client.closed,false,'an old household response cannot expire the current session');
    }
    holdReply=null;
    f.env.DIARY_ENCRYPTION_ENABLED='false';
    assert.equal((await call('/diary/api/photo-upload-sessions',{method:'POST',body:{}})).status,423);
    assert.equal((await call(`/diary/api/photo-upload-sessions/${newSession}/photos`,{method:'POST',body:retry})).status,423);
    delete f.env.DIARY_ENCRYPTION_ENABLED;
    assert.equal((await call(`/diary/api/photo-upload-sessions/${newSession}/photos`,{method:'POST',body:retry})).status,423);
    assert.equal(puts,3);media.close();
  }finally{delete crypto.DigestStream;media?.close();client.lock();delete globalThis.location;await f.close();}
});
