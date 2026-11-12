import { open,seal } from './crypto.mjs';
import { preferencesScope } from './policy.mjs';
export function createEncryptedMediaClient(client,request,nativeFetch) {
  const pending=new Map();
  const binding=(session,id,epoch)=>({household:client.household,scope:preferencesScope(client.household,client.actor.accountId),id,revision:1,epoch,kind:'photo-staging',sourceId:session});
  async function metadata(session,id) {
    const saved=pending.get(`${session}:${id}`);if(saved)return saved.photo;
    const reply=await request(`/uploads/${session}/photos/${id}`);
    const value=await open(client.keys.get(preferencesScope(client.household,client.actor.accountId)),reply.metadata,binding(session,id,reply.epoch));
    if(value.id!==id||typeof value.fileName!=='string')throw new Error('InvalidPhotoMetadata');return value;
  }
  const api=async(path,method,body)=>{
    const route=path.replace('/photo-upload-sessions','/uploads');
    if(method==='POST'&&route.endsWith('/commit')) {
      const session=route.split('/')[2],photos=[];
      for(const id of body.photoIds)photos.push(await metadata(session,id));
      await client.attachPhotos(body.entryId,photos);
      await request(route,{method,body});return {photos};
    }
    return request(route,{method,body:method==='GET'?undefined:body});
  };
  const fetchMedia=async(input,init={})=>{
    const url=new URL(input,location.href),match=url.pathname.match(/^\/diary\/api\/photo-upload-sessions\/([0-9a-f-]{36})\/photos(?:\/([0-9a-f-]{36}))?$/);
    if(!match)return nativeFetch(input,init);
    const session=match[1],route=`/uploads/${session}/photos${match[2]?'/'+match[2]:''}`;
    try {
      if(init.method==='POST') {
        const form=init.body;if(!(form instanceof FormData))throw new Error('InvalidUpload');
        const id=form.get('id'),scope=preferencesScope(client.household,client.actor.accountId),epoch=client.directory.epochs[scope],key=client.keys.get(scope),identity=`${session}:${id}`;
        const original=form.get('original');let saved=pending.get(identity);
        if(!saved) {
          const photo={id,fileName:original.name,contentType:original.type,originalSize:original.size,width:Number(form.get('width'))||null,height:Number(form.get('height'))||null,createdAt:await client.transport.timestamp(),createdByName:client.profile.displayName,thumbnailUrl:`/diary/api/photos/${id}/thumbnail`,displayUrl:`/diary/api/photos/${id}/display`,originalUrl:`/diary/api/photos/${id}/original`};
          saved={photo,epoch,envelope:await seal(key,photo,binding(session,id,epoch))};pending.set(identity,saved);
        }
        const upload=new FormData();upload.set('id',id);upload.set('epoch',String(saved.epoch));upload.set('metadata',JSON.stringify(saved.envelope));
        for(const kind of ['original','display','thumbnail'])upload.set(kind,new Blob([form.get(kind)],{type:'application/octet-stream'}),`${kind}.bin`);
        return await nativeFetch(`/diary/api/encryption${route}`,{...init,body:upload});
      }
      return await nativeFetch(`/diary/api/encryption${route}`,init);
    }catch(error){if(error.name==='AbortError')throw error;return Response.json({error:'写真を安全に保存できませんでした。編集内容を保管して再試行してください。'},{status:error.status||500});}
  };
  return {api,fetch:fetchMedia,retire:id=>request(`/media/${id}`,{method:'DELETE'}),close:()=>pending.clear()};
}
