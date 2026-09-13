import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const fixture=await startUIFixture();
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{
  const page=await browser.newPage({viewport:{width:390,height:740}});
  await preparePage(page,fixture.origin,0);
  const payload=await page.evaluate(async()=>{
   const pack=await TRoomCrypto.createFilePackage(new File([__thumb.blob],'cached photo.png',{type:'image/png'}),__thumb.key,'image');
   __test.state.folderId=7;__test.state.crypto.folderKeys.set(7,__thumb.key);
   return {file:{id:1,folderId:7,...pack.payload,name:'[encrypted]',mediaKind:'other',mimeType:'application/octet-stream',hasThumbnail:true,createdAt:'2026-09-14 00:00:00'},
    thumbnail:[...new Uint8Array(await(await TRoomCrypto.encryptThumbnail(__thumb.blob,pack.fileKey)).arrayBuffer())]};
  });
  let hold=false,release,answered=0,thumbnailRequests=0;
  const network=[];
  await page.route('**/cloud/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());network.push({method:req.method(),body:req.postData(),path:url.pathname});
   if(url.pathname.endsWith('/items')){
    if(hold)await new Promise(r=>{release=r;});
    answered++;
    await route.fulfill({json:{folders:[],files:[payload.file],breadcrumbs:[],folder:{fileCount:1},nextFolderOffset:null,nextFileOffset:null}});
   }else if(url.pathname.endsWith('/thumbnail')){thumbnailRequests++;await route.fulfill({body:Buffer.from(payload.thumbnail)});}
   else await route.fulfill({json:{ok:true}});
  });
  await page.evaluate(()=>__test.loadItems());
  await page.waitForFunction(()=>document.querySelector('.thumb img')?.naturalWidth>0&&__test.state.thumbnailLoadActive===0);
  await page.evaluate(async()=>{
   for(let i=0;i<100;i++){if((await TCloudDisplayCache.summary(__test.displayCacheScope())).listingCount>0)return;await new Promise(r=>setTimeout(r,20));}
   throw new Error('Listing cache was not saved');
  });
  assert.equal(thumbnailRequests,1,JSON.stringify({network,state:await page.evaluate(()=>({images:document.querySelectorAll('.thumb img').length,files:__test.state.files.map(f=>({id:f.id,kind:f.mediaKind,has:f.hasThumbnail,key:!!f.fileKey})),active:__test.state.thumbnailLoadActive}))}));
  const scope=await page.evaluate(()=>__test.displayCacheScope());
  // An authenticated new session can show the same disk cache before /items replies.
  await page.evaluate(()=>{
   window.initialSession={...__test.state.session};window.folderKey=__thumb.key;
   __test.releaseSessionState();
  });
  assert.equal(await page.locator('#content-grid .file-card').count(),0);
  assert.equal(await page.evaluate(()=>__test.displayCacheScope()),'');
  assert.equal(await page.evaluate(async s=>(await TCloudDisplayCache.summary(s)).thumbnailCount,scope),1);
  hold=true;const before=answered;
  await page.evaluate(()=>{
   __test.prepare(0);__test.state.folderId=7;
   __test.state.session={...initialSession,sessionCacheId:'new-authenticated-session'};
   __test.state.crypto.folderKeys.set(7,folderKey);
   window.cacheStarted=performance.now();window.pendingItems=__test.loadItems();
  });
  await page.waitForFunction(()=>document.querySelector('.file-card .thumb img')?.naturalWidth>0);
  assert.equal(answered,before,'cached listing and thumbnail appeared while server response was held');
  assert.equal(thumbnailRequests,1,'warm login did not fetch thumbnail');
  assert.equal(await page.evaluate(()=>__test.displayCacheScope()),scope);
  assert.equal(await page.evaluate(()=>__test.state.files[0].fileKey==null),true,'display records contain no file keys');
  const milliseconds=await page.evaluate(()=>Math.round(performance.now()-cacheStarted));
  payload.file={...payload.file,sizeBytes:987654};hold=false;release();
  await page.evaluate(()=>pendingItems);
  assert.equal(await page.evaluate(()=>__test.state.files[0].sizeBytes),987654,'fresh server data reconciled');
  assert.equal(await page.evaluate(()=>__test.state.files[0].fileKey instanceof CryptoKey),true,'current authorized key hydration restored actions');
  assert.ok(network.every(r=>r.method==='GET'&&r.body===null&&!r.path.includes('display-thumbnail')),'no plaintext or key upload');
  const migration=await page.evaluate(async()=>{
   const session={role:'member',serviceAccountId:'folder-member',serviceLinkId:'migration-link',rootFolderId:7,sessionCacheId:'current-session'};
   __test.releaseSessionState();__test.state.session=session;
   const old=__test.legacyDisplayCacheScope(),next=__test.displayCacheScope();
   await TCloudDisplayCache.putListing(old,'listing',{files:[{id:8,name:'cached'}]});
   await TCloudDisplayCache.putThumbnail(old,8,'v1',__thumb.blob);
   const listing=await TCloudDisplayCache.getListing(next,'listing',old),thumbnail=await TCloudDisplayCache.getThumbnail(next,8,'v1',old);
   const oldCount=(await TCloudDisplayCache.summary(old)).thumbnailCount;
   await TCloudDisplayCache.putListing(next,'listing',{files:[{id:8,name:'newer'}]});
   const preferred=await TCloudDisplayCache.getListing(next,'listing',old);
   __test.state.session={...session,sessionCacheId:'another-session'};
   const reused=!!await TCloudDisplayCache.getThumbnail(__test.displayCacheScope(),8,'v1',__test.legacyDisplayCacheScope());
   const isolated=[];
   for(const changes of [{role:'admin'},{role:'subadmin'},{serviceLinkId:'other'},{rootFolderId:9},{serviceAccountId:'other'}]){
    __test.state.session={...session,...changes};isolated.push(!await TCloudDisplayCache.getThumbnail(__test.displayCacheScope(),8,'v1',__test.legacyDisplayCacheScope()));
   }
   __test.state.session=session;__test.state.view='all';__test.state.folderId=7;
   const locked=await __test.readDisplayListingCache('listing');
   return {listing:listing.files[0].name,thumbnail:!!thumbnail,oldCount,preferred:preferred.files[0].name,reused,isolated,locked};
  });
  assert.deepEqual(migration,{listing:'cached',thumbnail:true,oldCount:1,preferred:'newer',reused:true,isolated:[true,true,true,true,true],locked:null});
  console.log('PASS persistent display cache',name,JSON.stringify({cacheBeforeServerMs:milliseconds,logoutPreserved:true,reloginHit:true,lazyMigration:true,accountAndFolderIsolation:true}));
 }finally{await browser.close();}
}}finally{await fixture.close();}
