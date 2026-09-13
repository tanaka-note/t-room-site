import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
let handleAPI=null;
const fixture=await startUIFixture(undefined,{handleRequest:(req,res)=>handleAPI?.(req,res)});
try {for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try {
  const page=await browser.newPage();await preparePage(page,fixture.origin,0);
  const input=await page.evaluate(async()=>{
   const folderKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);__test.state.crypto.folderKeys.set(1,folderKey);
   globalThis.bulkKeys=new Map();const records=[],posters={};
   const canvas=document.createElement('canvas');canvas.width=64;canvas.height=36;const c=canvas.getContext('2d');
   for(let id=1;id<=257;id++){
    const pack=await TRoomCrypto.createFilePackage(new File(['synthetic'],`fixture-${id}.mp4`,{type:'video/mp4'}),folderKey,'video');
    records.push({...pack.payload,id,folderId:1,mediaKind:'other',hasThumbnail:id!==2,createdAt:'2026-09-13 00:00:00'});bulkKeys.set(id,pack.fileKey);
    c.fillStyle=id===1?'#fff':id===5?'#248080':'#000';c.fillRect(0,0,64,36);
    const blob=id>5?__thumb.blob:id===3?new Blob(['invalid image']):await new Promise(r=>canvas.toBlob(r,'image/png'));
    posters[id]=[...new Uint8Array(await(await TRoomCrypto.encryptThumbnail(blob,pack.fileKey)).arrayBuffer())];
   }
   globalThis.bulkActive=0;globalThis.bulkMax=0;globalThis.bulkStarted=[];globalThis.bulkReleased=0;
   globalThis.TCloudMedia={...TCloudMedia,registerMedia:async file=>{bulkStarted.push(file.id);return {token:String(file.id),url:'/local-decoder/'+file.id};},releaseMedia:()=>bulkReleased++};
   globalThis.TCloudUI={...TCloudUI,recoverVideoThumbnail:async url=>{bulkActive++;bulkMax=Math.max(bulkMax,bulkActive);await new Promise(r=>setTimeout(r,10));bulkActive--;return url.endsWith('/4')?null:__thumb.blob;}};
   return {records,posters};
  });
  const uploads=[];let pages=0,gets=0,retried=false,deny=false;
  handleAPI=async(request,response)=>{
   const url=new URL(request.url,'http://fixture');if(!url.pathname.startsWith('/cloud/api/'))return false;
   const reply=(status,value,binary=false)=>{response.writeHead(status,{'Content-Type':binary?'application/octet-stream':'application/json'});response.end(binary?value:JSON.stringify(value));return true;};
   assert.equal(url.searchParams.has('q'),false);
   if(url.pathname.endsWith('/items')){
    assert.equal(request.method,'GET');assert.equal(url.searchParams.get('searchCandidates'),'1');
    if(deny)return reply(403,{error:'revoked'});
    pages++;const offset=Number(url.searchParams.get('offset')||0),size=Number(url.searchParams.get('pageSize'));
    return reply(200,{files:input.records.slice(offset,offset+size),searchFolders:[],nextFileOffset:offset+size<input.records.length?offset+size:null});
   }
   const match=/\/files\/(\d+)\/thumbnail$/.exec(url.pathname);assert.ok(match,'Only thumbnail APIs are allowed');const id=Number(match[1]);
   if(request.method==='GET'){gets++;return reply(200,Buffer.from(input.posters[id]),true);}
   assert.equal(request.method,'PUT');
   const parts=[];for await(const part of request)parts.push(part);const bytes=[...Buffer.concat(parts)];
   if(id===3&&!retried){retried=true;return reply(503,{error:'temporary'});}
   uploads.push({id,bytes});return reply(200,{ok:true});
  };
  await page.evaluate(()=>__test.startThumbnailMaintenance());
  const result=await page.evaluate(()=>({scanned:__test.state.thumbnailMaintenance.scanned,videos:__test.state.thumbnailMaintenance.videos,healthy:__test.state.thumbnailMaintenance.healthy,repaired:__test.state.thumbnailMaintenance.repaired,failed:__test.state.thumbnailMaintenance.failed,running:__test.state.thumbnailMaintenance.running,max:bulkMax,started:bulkStarted.length,released:bulkReleased,status:document.querySelector('#thumbnail-maintenance-status').textContent}));
  assert.equal(result.scanned,257);assert.equal(result.videos,257);assert.equal(result.healthy,252);assert.equal(result.repaired,4);assert.equal(result.failed,1);assert.equal(result.running,false);assert.equal(result.max,1);assert.equal(result.started,5);assert.equal(result.released,5);assert.match(result.status,/未完了あり/);
  assert.equal(pages,2);assert.equal(gets,256);assert.equal(uploads.length,4);assert.equal(retried,true);
  for(const uploaded of uploads)assert.equal(await page.evaluate(async({id,bytes})=>{
   const plain=await TRoomCrypto.decryptThumbnail(new Uint8Array(bytes).buffer,bulkKeys.get(id));
   const decoded=await TCloudUI.decodeThumbnail(new Blob([plain]));try{return !TCloudUI.isBlankVideoFrame(decoded.image)&&plain.byteLength<bytes.length;}finally{URL.revokeObjectURL(decoded.url);}
  },uploaded),true);
  console.log('PASS 257 files, offscreen persistence, skip healthy, white/solid/corrupt/missing recovery, encrypted-only PUT, retry, single decoder',name,result);
  deny=true;const previous=uploads.length;await page.evaluate(()=>__test.startThumbnailMaintenance());assert.equal(uploads.length,previous);assert.equal(await page.evaluate(()=>__test.state.thumbnailMaintenance.running),false);assert.match(await page.locator('#thumbnail-maintenance-status').textContent(),/停止/);console.log('PASS permission failure stops maintenance',name);
  deny=false;input.records=input.records.slice(0,1);
  const cancelled=await page.evaluate(async()=>{
   let entered;const started=new Promise(r=>entered=r);globalThis.bulkEntered=entered;
   globalThis.TCloudUI={...TCloudUI,recoverVideoThumbnail:async()=>{bulkEntered();await new Promise(r=>setTimeout(r,60));return __thumb.blob;}};
   const pending=__test.startThumbnailMaintenance();await started;__test.releaseSessionState();await pending;
   return {running:__test.state.thumbnailMaintenance.running,failedNames:document.querySelector('#thumbnail-maintenance-failures').childElementCount,keys:__test.state.crypto.folderKeys.size};
  });
  assert.deepEqual(cancelled,{running:false,failedNames:0,keys:0});assert.equal(uploads.length,previous);console.log('PASS logout cancels late image persistence and clears keys/report names',name);
 }finally{handleAPI=null;await browser.close();}
}}finally{await fixture.close();}
