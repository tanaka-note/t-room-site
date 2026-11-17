import { open,seal } from './crypto.mjs';
import { preferencesScope } from './policy.mjs';
import {encryptPhotoParts,decryptPhotoPart} from './photo-crypto.mjs';
export function createEncryptedMediaClient(client,request,nativeFetch) {
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
  async function read(photo,kind,{signal}={}) {
    const generation=client.generation,household=client.household;
    await client.check();assertCurrent(generation,signal);
    // A removed reference must not keep serving a cached plaintext image.
    if(![...client.records.values()].some(record=>record.row.photoIds.includes(photo.id)))throw Object.assign(new Error('PhotoNotFound'),{status:404});
    const identity=JSON.stringify([generation,household,photo.id,kind,photo.crypto||null]);
    if(cache.has(identity)){const blob=cache.get(identity);cache.delete(identity);cache.set(identity,blob);return blob;}
    let promise=kind==='original'?null:loads.get(identity);
    if(!promise) {
      const controller=new AbortController();controllers.add(controller);
      const combined=kind==='original'&&signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      promise=(async()=>{
        const response=await nativeFetch(`/diary/api/photos/${photo.id}/${kind}`,{credentials:'same-origin',cache:'no-store',signal:combined});
        if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('PhotoReadFailed'),{status:response.status});}
        const raw=await response.arrayBuffer();assertCurrent(generation,combined);
        const blob=photo.crypto?await decryptPhotoPart(raw,photo.crypto,household,photo.id,kind):new Blob([raw],{type:kind==='original'?photo.contentType:'image/webp'});
        assertCurrent(generation,combined);
        if(kind==='original'&&blob.size!==photo.originalSize)throw new Error('PhotoSizeMismatch');
        if(kind!=='original'&&blob.size<=24*1024*1024){
          cache.set(identity,blob);bytes+=blob.size;
          while(cache.size>64||bytes>24*1024*1024){const oldest=cache.keys().next().value;bytes-=cache.get(oldest).size;cache.delete(oldest);}
        }
        return blob;
      })().finally(()=>{controllers.delete(controller);if(loads.get(identity)===promise)loads.delete(identity);});
      if(kind!=='original')loads.set(identity,promise);
    }
    const blob=await promise;assertCurrent(generation,signal);return blob;
  }
  const fetchMedia=async(input,init={})=>{
    const url=new URL(input,location.href);
    if(url.origin!==location.origin)return nativeFetch(input,init);
    const asset=url.pathname.match(/^\/diary\/api\/photos\/([0-9a-f-]{36})\/(original|display|thumbnail)$/);
    if(asset&&(!init.method||init.method==='GET')) {
      const photo=await findPhoto(asset[1]),blob=await read(photo,asset[2],init);
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
  return {api,fetch:fetchMedia,read,reset,retire:id=>request(`/media/${id}`,{method:'DELETE'}),close:()=>{closed=true;reset();}};
}
