import { findPhotoMarkers } from '../public/diary-rich-text.js';
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function createEncryptedDiaryApi(client,{session,nativeApi,media,onHousehold,parallelStartupRead=false,prepareNavigation=async()=>{}}) {
  let initialized=false,syncing=null,selecting=null;
  const synchronize=async()=>{
    const generation=client.generation;
    if(!syncing||syncing.generation!==generation){
      const pending={generation,promise:client.sync({parallelStartupRead:parallelStartupRead&&!initialized})};syncing=pending;
      void pending.promise.finally(()=>{if(syncing===pending)syncing=null;}).catch(()=>{});
    }
    await syncing.promise;client.assertOpen(generation);await prepareNavigation();client.assertOpen(generation);initialized=true;
  };
  const photoOrder = (a, b) => -(a.entryDate.localeCompare(b.entryDate) || a._published.localeCompare(b._published)
    || a.entryId - b.entryId || a._position - b._position || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    || a.id.localeCompare(b.id));
  const albumPhoto = ({_position, _published, _tags, _content, ...photo}) => photo;
  function collectPhotos(records) {
    const photos = [];
    for (const {row} of records) {
      if (row.state !== 'published' || !row.photoIds.length) continue;
      const entry = client.entry(row.id);
      const order = new Map(findPhotoMarkers(entry.content).map((marker, i) => [marker.id, i]));
      for (const photo of entry.photos) {
        photos.push({...photo, entryId:entry.id, entryDate:entry.entryDate, entryTitle:entry.title, authorId:entry.authorId,
          authorName:entry.authorName, revision:entry.revision, _position:order.get(photo.id) ?? -1,
          _published:entry.lastPublishedAt || '', _tags:entry.tags, _content:entry.content});
      }
    }
    return photos.sort(photoOrder);
  }

  function albumIndex() {
    const {records, sequence} = client;
    if (client.albumCache?.records === records && client.albumCache.sequence === sequence) return client.albumCache;
    const byDate = new Map();
    for (const record of records.values()) {
      if (record.row.state !== 'published' || !record.row.photoIds.length) continue;
      const date = (record.entry || record.summary).entryDate;
      if (!byDate.has(date)) byDate.set(date, {date, records:[], count:0, photos:null});
      const day = byDate.get(date);
      day.records.push(record);
      day.count += record.row.photoIds.length;
    }
    const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
    const index = {records, sequence, days, photos:null};
    client.albumCache = index;
    return index;
  }

  function photosForDay(day) {
    return day.photos ??= collectPhotos(day.records);
  }

  async function photoPage({month, oldest, offset, limit}) {
    const generation = client.generation;
    const index = albumIndex();
    const days = index.days.filter(day => !month || day.date.startsWith(month));
    if (oldest) days.reverse();
    const page = [];
    let count = 0, skipped = 0;
    const end = offset + limit;
    for (const day of days) {
      // All articles on an intersecting day are needed to preserve publication
      // order and the within-article order at both page boundaries.
      if (count + day.count <= offset) skipped += day.count;
      else if (count < end) page.push(day);
      count += day.count;
    }
    await client.hydrateRecords(page.filter(day => !day.photos).flatMap(day => day.records));
    client.assertOpen(generation);
    if (index.records !== client.records || index.sequence !== client.sequence) fail(409, '写真一覧が更新されました。もう一度お試しください。');
    const photos = page.flatMap(day => oldest ? photosForDay(day).slice().reverse() : photosForDay(day));
    return {photos:photos.slice(offset - skipped, end - skipped).map(albumPhoto), hasMore:count > end, offset, limit};
  }

  function allPhotos() {
    const index = albumIndex();
    return index.photos ??= index.days.flatMap(photosForDay);
  }
  return async(path,options={})=>{
    const url=new URL(path,'https://diary.invalid'),method=options.method||'GET',body=options.body?typeof options.body==='string'?JSON.parse(options.body):options.body:{};
    if(url.pathname==='/passkey/handoff')return nativeApi(path,options);
    if(url.pathname==='/session'){const result=await nativeApi(path,options);if(!result.authenticated||!result.encryption?.enabled||result.encryption.accountId!==client.actor.accountId||result.encryption.webAuthnCredentialId!==client.profile.webAuthnCredentialId){client.lock();fail(401,'SessionChanged');}return result;}
    if(url.pathname==='/logout'){try{return await nativeApi(path,options);}finally{client.lock();}}
    if(url.pathname==='/households'||url.pathname==='/households/select') {
      if(method==='GET')return nativeApi(path,options);
      if(selecting)await selecting;
      client.generation++;client.switching=true;
      const pending=(async()=>{const result=await nativeApi(path,options);await onHousehold(body.householdId);session.activeHouseholdId=body.householdId;initialized=false;return result;})();selecting=pending;
      try{return await pending;}finally{client.switching=false;if(selecting===pending)selecting=null;}
    }
    if(selecting)await selecting;
    if(url.pathname==='/bootstrap') {
      const [,households]=await Promise.all([synchronize(),nativeApi('/households')]);
      await client.ensureList(url.searchParams);const entries=client.list(url.searchParams);client.startBackground();
      return {session,households,meta:client.meta(),entries};
    }
    // Foreground reads must observe other devices. Concurrent metadata/list
    // reads share one synchronization, but no authorization result is cached.
    if(!initialized||method==='GET')await synchronize();
    if(url.pathname==='/meta'){await prepareNavigation();return client.meta();}
    if(url.pathname==='/entries') {
      if(method==='GET'){await client.ensureList(url.searchParams);const result=client.list(url.searchParams);client.startBackground();return result;}
      if(method!=='POST')fail(405,'MethodNotAllowed');const result=await client.saveEntry(body);await prepareNavigation();return result;
    }
    const entry=url.pathname.match(/^\/entries\/(\d+)$/);
    if(entry){
      if(method==='GET'){await client.hydrate(entry[1]);client.startBackground();return {entry:client.entry(entry[1])};}
      if(method==='DELETE')return client.transition(entry[1],'trash',body.revision);
      if(method==='PUT'){const result=await client.saveEntry(body,entry[1]);await prepareNavigation();return result;}
      fail(405,'MethodNotAllowed');
    }
    const action=url.pathname.match(/^\/entries\/(\d+)\/(favorite|restore|permanent)$/);
    if(action){if(action[2]==='favorite'&&['POST','DELETE'].includes(method))return client.setFavorite(action[1],method==='POST');if(action[2]==='restore'&&method==='POST')return client.transition(action[1],'restore');if(action[2]==='permanent'&&method==='DELETE')return client.transition(action[1],'purge',body.revision);fail(405,'MethodNotAllowed');}
    const draft=url.pathname.match(/^\/drafts\/(\d+)$/);if(draft&&method==='DELETE')return client.transition(draft[1],'discard',body.revision);
    if(url.pathname==='/photos/meta') {
      const counts=new Map();for(const record of client.records.values())if(record.row.state==='published'){
        const month=(record.entry||record.summary).entryDate.slice(0,7);counts.set(month,(counts.get(month)||0)+record.row.photoIds.length);
      }
      return {months:[...counts].filter(([,count])=>count>0).sort((a,b)=>b[0].localeCompare(a[0])).map(([value,count])=>({value,count}))};
    }
    if(url.pathname==='/photos'||url.pathname==='/photos/save-list') {
      const p=url.searchParams,month=p.get('month'),entryQuery=p.get('entryQuery'),fileNameQuery=p.get('fileName'),from=p.get('dateFrom'),to=p.get('dateTo');
      const saving=url.pathname==='/photos/save-list';if(saving&&(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||from>to))fail(400,'InvalidDates');
      const offset=Math.max(0,Number(p.get('offset'))||0),limit=Math.min(100,Math.max(1,Number(p.get('limit'))||48));
      const oldest = month && p.get('order') === 'oldest';
      if (!saving && !entryQuery && !fileNameQuery && !from && !to) return photoPage({month, oldest, offset, limit});

      await client.hydrateRecords([...client.records.values()].filter(record=>record.row.state==='published'));
      const result=allPhotos().filter(photo=>(!month||photo.entryDate.startsWith(month))&&(!from||photo.entryDate>=from)&&(!to||photo.entryDate<=to)&&(!fileNameQuery||photo.fileName.includes(fileNameQuery))&&(!entryQuery||photo.entryTitle.includes(entryQuery)||photo._content.includes(entryQuery)||photo.fileName.includes(entryQuery)||photo._tags.some(t=>t.includes(entryQuery))));
      if(saving||oldest)result.reverse();
      if(saving)return {photos:result.map(({id,fileName,contentType,originalSize})=>({id,fileName,contentType,originalSize}))};
      return {photos:result.slice(offset,offset+limit).map(albumPhoto),hasMore:result.length>offset+limit,offset,limit};
    }
    const photo=url.pathname.match(/^\/photos\/([0-9a-f-]{36})$/);
    if(photo&&method==='DELETE')return body.revision?client.deletePhoto(photo[1],body.revision):media.retire(photo[1]);
    if(url.pathname.startsWith('/photo-upload-sessions'))return media.api(url.pathname,method,body);
    fail(404,'EncryptedRouteUnavailable');
  };
}
