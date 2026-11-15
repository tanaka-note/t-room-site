import { findPhotoMarkers } from '../public/diary-rich-text.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function createEncryptedDiaryApi(client,{session,nativeApi,media,onHousehold,prepareNavigation=async()=>{}}) {
  let initialized=false,syncing=null;
  const synchronize=async()=>{if(!syncing)syncing=client.sync().finally(()=>{syncing=null;});await syncing;await prepareNavigation();initialized=true;};
  const photos=()=>{
    const output=[];
    for(const {row} of client.records.values())if(row.state==='published') {
      const entry=client.entry(row.id),order=new Map(findPhotoMarkers(entry.content).map((marker,i)=>[marker.id,i]));
      for(const photo of entry.photos)output.push({...photo,entryId:entry.id,entryDate:entry.entryDate,entryTitle:entry.title,authorId:entry.authorId,authorName:entry.authorName,revision:entry.revision,_position:order.get(photo.id)??1e9,_published:entry.lastPublishedAt||'',_tags:entry.tags,_content:entry.content});
    }
    return output;
  };
  return async(path,options={})=>{
    const url=new URL(path,'https://diary.invalid'),method=options.method||'GET',body=options.body?typeof options.body==='string'?JSON.parse(options.body):options.body:{};
    if(url.pathname==='/passkey/handoff')return nativeApi(path,options);
    if(url.pathname==='/session'){const result=await nativeApi(path,options);if(!result.authenticated||!result.encryption?.enabled||result.encryption.accountId!==client.actor.accountId||result.encryption.webAuthnCredentialId!==client.profile.webAuthnCredentialId){client.lock();fail(401,'SessionChanged');}return result;}
    if(url.pathname==='/logout'){try{return await nativeApi(path,options);}finally{client.lock();}}
    if(url.pathname==='/households'||url.pathname==='/households/select') {
      const result=await nativeApi(path,options);if(method!=='GET'){await onHousehold(body.householdId);session.activeHouseholdId=body.householdId;initialized=false;}return result;
    }
    if(!initialized)await synchronize();
    if(url.pathname==='/bootstrap')return {session,households:await nativeApi('/households'),meta:client.meta(),entries:client.list(url.searchParams)};
    if(url.pathname==='/meta'){await prepareNavigation();return client.meta();}
    if(url.pathname==='/entries') {
      if(method==='GET')return client.list(url.searchParams);
      if(method!=='POST')fail(405,'MethodNotAllowed');const result=await client.saveEntry(body);await prepareNavigation();return result;
    }
    const entry=url.pathname.match(/^\/entries\/(\d+)$/);
    if(entry){
      if(method==='GET')return {entry:client.entry(entry[1])};
      if(method==='DELETE')return client.transition(entry[1],'trash',body.revision);
      if(method==='PUT'){const result=await client.saveEntry(body,entry[1]);await prepareNavigation();return result;}
      fail(405,'MethodNotAllowed');
    }
    const action=url.pathname.match(/^\/entries\/(\d+)\/(favorite|restore|permanent)$/);
    if(action){if(action[2]==='favorite'&&['POST','DELETE'].includes(method))return client.setFavorite(action[1],method==='POST');if(action[2]==='restore'&&method==='POST')return client.transition(action[1],'restore');if(action[2]==='permanent'&&method==='DELETE')return client.transition(action[1],'purge',body.revision);fail(405,'MethodNotAllowed');}
    const draft=url.pathname.match(/^\/drafts\/(\d+)$/);if(draft&&method==='DELETE')return client.transition(draft[1],'discard',body.revision);
    if(url.pathname==='/photos/meta') {
      const counts=new Map();for(const photo of photos()){const month=photo.entryDate.slice(0,7);counts.set(month,(counts.get(month)||0)+1);}return {months:[...counts].sort((a,b)=>b[0].localeCompare(a[0])).map(([value,count])=>({value,count}))};
    }
    if(url.pathname==='/photos'||url.pathname==='/photos/save-list') {
      const p=url.searchParams,month=p.get('month'),entryQuery=p.get('entryQuery'),fileNameQuery=p.get('fileName'),from=p.get('dateFrom'),to=p.get('dateTo');
      const saving=url.pathname==='/photos/save-list';if(saving&&(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||from>to))fail(400,'InvalidDates');
      let result=photos().filter(photo=>(!month||photo.entryDate.startsWith(month))&&(!from||photo.entryDate>=from)&&(!to||photo.entryDate<=to)&&(!fileNameQuery||photo.fileName.includes(fileNameQuery))&&(!entryQuery||photo.entryTitle.includes(entryQuery)||photo._content.includes(entryQuery)||photo.fileName.includes(entryQuery)||photo._tags.some(t=>t.includes(entryQuery))));
      const sign=saving||month&&p.get('order')==='oldest'?1:-1;
      result.sort((a,b)=>sign*(a.entryDate.localeCompare(b.entryDate)||a._published.localeCompare(b._published)||a.entryId-b.entryId||a._position-b._position||String(a.createdAt||'').localeCompare(String(b.createdAt||''))||a.id.localeCompare(b.id)));
      result=result.map(({_position,_published,_tags,_content,...photo})=>photo);
      if(saving)return {photos:result.map(({id,fileName,contentType,originalSize})=>({id,fileName,contentType,originalSize}))};
      const offset=Math.max(0,Number(p.get('offset'))||0),limit=Math.min(100,Math.max(1,Number(p.get('limit'))||48));return {photos:result.slice(offset,offset+limit),hasMore:result.length>offset+limit,offset,limit};
    }
    const photo=url.pathname.match(/^\/photos\/([0-9a-f-]{36})$/);
    if(photo&&method==='DELETE')return body.revision?client.deletePhoto(photo[1],body.revision):media.retire(photo[1]);
    if(url.pathname.startsWith('/photo-upload-sessions'))return media.api(url.pathname,method,body);
    fail(404,'EncryptedRouteUnavailable');
  };
}
