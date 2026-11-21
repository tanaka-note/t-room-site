import { open,seal } from './crypto.mjs';
import { preferencesScope } from './policy.mjs';
import {encryptPhotoParts,decryptPhotoPart} from './photo-crypto.mjs';
import {PHOTO_CONTEXT_HEADER, PHOTO_FORMAT_HEADER, PHOTO_EXPIRY_HEADER, validPhotoEtag} from './session.mjs';

const abortPhoto = () => new DOMException('Aborted', 'AbortError');
const failPhoto = (status,message) => Object.assign(new Error(message),{status});
const MAX_PHOTO_CACHE_BYTES = 64 * 1024 * 1024;

export function createEncryptedMediaClient(client,request,nativeFetch,{photoContext,onPhotoExpiry=()=>{},encryptedOnly=false}) {
  const pending=new Map(),cache=new Map(),loads=new Map(),controllers=new Set();
  let bytes=0,closed=false;
  const binding=(session,id,epoch)=>({household:client.household,scope:preferencesScope(client.household,client.actor.accountId),id,revision:1,epoch,kind:'photo-staging',sourceId:session});
  const assertCurrent=(generation,signal)=>{client.assertOpen(generation);if(closed||signal?.aborted)throw new DOMException('Aborted','AbortError');};
  async function metadata(session,id) {
    const saved=await pending.get(`${session}:${id}`);if(saved)return saved.photo;
    const reply=await request(`/uploads/${session}/photos/${id}`);
    const value=await open(client.keys.get(preferencesScope(client.household,client.actor.accountId)),reply.metadata,binding(session,id,reply.epoch));
    if(value.id!==id||typeof value.fileName!=='string')throw new Error('InvalidPhotoMetadata');return value;
  }
  const api=async(path,method,body)=>{
    const route=path.replace('/photo-upload-sessions','/uploads');
    if(method==='POST'&&route.endsWith('/commit')) {
      const session=route.split('/')[2],photos=[];
      for(const id of body.photoIds)photos.push(await metadata(session,id));
      const result=await client.attachPhotos(body.entryId,photos);
      await request(route,{method,body});
      for(const id of body.photoIds)pending.delete(`${session}:${id}`);
      return {photos,entryRevision:result.revision};
    }
    const result=await request(route,{method,body:method==='GET'?undefined:body});
    if(method==='DELETE')for(const identity of pending.keys())if(identity.startsWith(route.split('/')[2]+':')&&(!route.split('/')[4]||identity.endsWith(':'+route.split('/')[4])))pending.delete(identity);
    return result;
  };
  async function findPhoto(id) {
    for(const record of client.records.values())if(record.row.photoIds.includes(id)){
      await client.hydrate(record.row.id);return client.entry(record.row.id).photos.find(photo=>photo.id===id);
    }
    throw Object.assign(new Error('PhotoNotFound'),{status:404});
  }
  function assertPhotoRead(generation, signal) {
    if(signal?.aborted||generation!==client.generation||client.switching)throw abortPhoto();
    assertCurrent(generation,signal);
  }

  function assertReferenced(id) {
    for(const record of client.records.values())if(record.row.photoIds.includes(id))return;
    throw failPhoto(404,'PhotoNotFound');
  }

  function rememberPhoto(identity, etag, blob) {
    if(cache.has(identity))bytes-=cache.get(identity).blob.size;
    cache.delete(identity);
    if(!validPhotoEtag(etag)||blob.size>MAX_PHOTO_CACHE_BYTES)return;
    cache.set(identity,{etag,blob});
    bytes+=blob.size;
    while(cache.size>192||bytes>MAX_PHOTO_CACHE_BYTES) {
      const oldest=cache.keys().next().value;
      bytes-=cache.get(oldest).blob.size;
      cache.delete(oldest);
    }
  }

  const cacheIdentity=(photo,kind,generation=client.generation,household=client.household)=>
    JSON.stringify([generation,household,photo.id,kind,photo.crypto||null]);
  const isPhotoCached=(photo,kind)=>!closed&&!client.closed&&!client.switching&&cache.has(cacheIdentity(photo,kind));

  async function requestPhoto(photo,kind,generation,household,identity,signal,priority) {
    const context=await photoContext();
    assertPhotoRead(generation,signal);
    if(!context)throw failPhoto(401,'PhotoSessionChanged');
    assertReferenced(photo.id);
    const snapshot=client.records,sequence=client.sequence;
    const cached=cache.get(identity);
    const format=encryptedOnly||photo.crypto?'encrypted':'legacy';
    const headers=new Headers({[PHOTO_CONTEXT_HEADER]:context,[PHOTO_FORMAT_HEADER]:format});
    if(cached)headers.set('If-None-Match',cached.etag);
    const response=await nativeFetch(`/diary/api/photos/${photo.id}/${kind}`,{credentials:'same-origin',cache:'no-store',headers,signal,priority});
    try {
      assertPhotoRead(generation,signal);
      if(!response.ok&&response.status!==304)throw failPhoto(response.status,'PhotoReadFailed');
      const expiresAt=Number(response.headers.get(PHOTO_EXPIRY_HEADER));
      if(response.headers.get(PHOTO_CONTEXT_HEADER)!==context||response.headers.get(PHOTO_FORMAT_HEADER)!==format
        ||!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw failPhoto(409,'PhotoResponseMismatch');
      if(Date.now()>=expiresAt*1000)throw abortPhoto();
      onPhotoExpiry(expiresAt);
      const etag=response.headers.get('ETag');
      let blob;
      if(response.status===304) {
        if(!cached||etag!==cached.etag)throw failPhoto(409,'PhotoResponseMismatch');
        blob=cached.blob;
      } else if(format==='encrypted') {
        const raw=await response.arrayBuffer();
        assertPhotoRead(generation,signal);
        blob=await decryptPhotoPart(raw,photo.crypto,household,photo.id,kind);
      } else {
        const raw=await response.blob();
        blob=raw.slice(0,raw.size,kind==='original'?photo.contentType:'image/webp');
      }
      assertPhotoRead(generation,signal);
      if(Date.now()>=expiresAt*1000)throw abortPhoto();
      if(client.records!==snapshot||client.sequence!==sequence)assertReferenced(photo.id);
      if(kind==='original'&&blob.size!==photo.originalSize)throw new Error('PhotoSizeMismatch');
      if(kind!=='original')rememberPhoto(identity,etag,blob);
      return blob;
    } catch(error) {
      if(response.body&&!response.bodyUsed)void response.body.cancel().catch(()=>{});
      throw error;
    }
  }

  async function read(photo,kind,{signal,priority='auto'}={}) {
    const generation=client.generation,household=client.household;
    assertPhotoRead(generation,signal);
    if(encryptedOnly&&!photo.crypto)throw failPhoto(409,'PhotoFormatChanged');
    const identity=cacheIdentity(photo,kind,generation,household);
    let load=loads.get(identity);
    if(!load) {
      const controller=new AbortController();
      load={controller,readers:0,finished:false};
      controllers.add(controller);
      load.promise=requestPhoto(photo,kind,generation,household,identity,controller.signal,priority).finally(()=>{
        load.finished=true;
        controllers.delete(controller);
        if(loads.get(identity)===load)loads.delete(identity);
      });
      if(kind!=='original')loads.set(identity,load);
    }
    load.readers++;
    let abort;
    try {
      const pending=signal?Promise.race([load.promise,new Promise((_,reject)=>{
        abort=()=>reject(abortPhoto());
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      })]):load.promise;
      const blob=await pending;
      assertPhotoRead(generation,load.controller.signal);
      assertPhotoRead(generation,signal);
      return blob;
    } catch(error) {
      // A late 401 from the prior household must not lock the active view.
      assertPhotoRead(generation,load.controller.signal);
      assertPhotoRead(generation,signal);
      throw error;
    } finally {
      if(abort)signal.removeEventListener('abort',abort);
      if(--load.readers===0&&!load.finished) {
        if(loads.get(identity)===load)loads.delete(identity);
        load.controller.abort();
      }
    }
  }
  async function prefetch(photo,kind,{signal}={}) {
    if(!isPhotoCached(photo,kind))await read(photo,kind,{signal,priority:'low'});
  }
  const fetchMedia=async(input,init={})=>{
    const url=new URL(input,location.href);
    if(url.origin!==location.origin)return nativeFetch(input,init);
    const asset=url.pathname.match(/^\/diary\/api\/photos\/([0-9a-f-]{36})\/(original|display|thumbnail)$/);
    if(asset&&(!init.method||init.method==='GET')) {
      const generation=client.generation;
      const photo=await findPhoto(asset[1]);
      assertPhotoRead(generation,init.signal);
      const blob=await read(photo,asset[2],init);
      return new Response(blob,{headers:{'Content-Type':blob.type,'Cache-Control':'no-store'}});
    }
    const match=url.pathname.match(/^\/diary\/api\/photo-upload-sessions\/([0-9a-f-]{36})(?:\/photos(?:\/([0-9a-f-]{36}))?)?$/);
    if(!match)return nativeFetch(input,init);
    const session=match[1],route=`/uploads/${session}${url.pathname.includes('/photos')?'/photos':''}${match[2]?'/'+match[2]:''}`,generation=client.generation;
    try {
      await client.check();assertCurrent(generation,init.signal);
      if(init.method==='POST') {
        const form=init.body;if(!(form instanceof FormData))throw new Error('InvalidUpload');
        const id=form.get('id'),scope=preferencesScope(client.household,client.actor.accountId),epoch=client.directory.epochs[scope],key=client.keys.get(scope),identity=`${session}:${id}`;
        if(!pending.has(identity))pending.set(identity,(async()=>{
          const original=form.get('original'),encrypted=await encryptPhotoParts(Object.fromEntries(['original','display','thumbnail'].map(kind=>[kind,form.get(kind)])),client.household,id);
          const photo={id,fileName:original.name,contentType:original.type,originalSize:original.size,width:Number(form.get('width'))||null,height:Number(form.get('height'))||null,createdAt:await client.transport.timestamp(),createdByName:client.profile.displayName,thumbnailUrl:`/diary/api/photos/${id}/thumbnail`,displayUrl:`/diary/api/photos/${id}/display`,originalUrl:`/diary/api/photos/${id}/original`,crypto:encrypted.descriptor};
          return {photo,epoch,parts:encrypted.parts,envelope:await seal(key,photo,binding(session,id,epoch))};
        })().catch(error=>{pending.delete(identity);throw error;}));
        const saved=await pending.get(identity);assertCurrent(generation,init.signal);
        if(!saved.parts)return nativeFetch(`/diary/api/encryption/uploads/${session}/photos/${id}`,{...init,method:'GET',body:undefined});
        const upload=new FormData();upload.set('id',id);upload.set('epoch',String(saved.epoch));upload.set('metadata',JSON.stringify(saved.envelope));
        for(const kind of ['original','display','thumbnail'])upload.set(kind,saved.parts[kind],`${kind}.bin`);
        const response=await nativeFetch(`/diary/api/encryption${route}`,{...init,body:upload});
        assertCurrent(generation,init.signal);if(response.ok)saved.parts=null;
        return response;
      }
      const response=await nativeFetch(`/diary/api/encryption${route}`,init);
      assertCurrent(generation,init.signal);
      if(response.ok&&init.method==='DELETE')for(const identity of pending.keys())if(identity.startsWith(session+':')&&(!match[2]||identity.endsWith(':'+match[2])))pending.delete(identity);
      if(response.ok&&match[2]){const saved=await pending.get(`${session}:${match[2]}`);if(saved)saved.parts=null;}
      return response;
    }catch(error){if(error.name==='AbortError')throw error;return Response.json({error:error.message==='PhotoEncryptionRequired'?'写真を選び直してください。本文は保持されています。':'写真を安全に保存できませんでした。編集内容を保管して再試行してください。'},{status:error.status||500});}
  };
  function reset(){for(const controller of controllers)controller.abort();controllers.clear();pending.clear();cache.clear();loads.clear();bytes=0;}
  return {api,fetch:fetchMedia,read,prefetch,isPhotoCached,reset,retire:id=>request(`/media/${id}`,{method:'DELETE'}),close:()=>{closed=true;reset();}};
}
