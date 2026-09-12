import assert from 'node:assert/strict';
import {engines,root,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce');
const fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT||root);
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try{
  const page=await browser.newPage({viewport:{width:390,height:740}});await preparePage(page,fixture.origin,0);
  let records=await page.evaluate(async()=>{
   const folderKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);__test.state.crypto.folderKeys.set(1,folderKey);globalThis.researchFolderKey=folderKey;
   globalThis.TCloudMedia={...TCloudMedia,registerMedia:async()=>{throw Error('No video decode in metadata search');}};
   const entries=[];
   for(let i=0;i<500;i++){
    const pack=await TRoomCrypto.createFilePackage(new File(['fixture'],`fixture ${i}.mp4`,{type:'video/mp4'}),folderKey,'video');
    const metadata=await TRoomCrypto.encryptFileMetadata({name:`fixture ${i}.mp4`,mimeType:'video/mp4',mediaKind:'video',durationSeconds:60},pack.fileKey);
    entries.push({...pack.payload,...metadata,id:i+1,folderId:1,name:'encrypted',mediaKind:'other',displayMetadataVersion:0,hasThumbnail:false,createdAt:'2026-09-13 00:00:00'});
   }
   const decrypt=TRoomCrypto.decryptFileMetadata;globalThis.metadataDecrypts=0;
   globalThis.TRoomCrypto={...TRoomCrypto,decryptFileMetadata:async(...args)=>{metadataDecrypts++;return decrypt(...args);}};
   return entries;
  });
  let requests=0,delivered=0,deny=false;
  await page.route('**/cloud/api/**',async route=>{
   const url=new URL(route.request().url());assert.equal(route.request().method(),'GET');assert.equal(route.request().postData(),null);
   assert.ok(url.pathname.endsWith('/items'),'search must not fetch video or write plaintext');
   if(deny){await route.fulfill({status:403,json:{error:'fixture permission revoked'}});return;}
   if(!before){assert.equal(url.searchParams.has('q'),false);assert.equal(url.searchParams.get('searchCandidates'),'1');}
   requests++;const offset=Number(url.searchParams.get('offset')||0),size=Number(url.searchParams.get('pageSize')||32),files=records.slice(offset,offset+size);delivered+=files.length;
   await new Promise(r=>setTimeout(r,120));
   await route.fulfill({json:{folders:[],files,breadcrumbs:[],searchFolders:[],nextFolderOffset:null,nextFileOffset:offset+size<records.length?offset+size:null}}).catch(()=>{});
  });
  const search=async query=>{
   requests=0;delivered=0;await page.evaluate(()=>metadataDecrypts=0);const started=performance.now();
   await page.evaluate(async query=>{__test.state.query=query;await __test.loadItems();},query);
   await page.waitForFunction(()=>!__test.state.progressiveItemsLoading);
   return {elapsedMs:Math.round(performance.now()-started),requests,delivered,...await page.evaluate(()=>({decrypts:metadataDecrypts,matches:__test.state.files.length,cards:document.querySelectorAll('.file-card').length}))};
  };
  if(process.argv.includes('--last-match')) {
   const result=await search('fixture 499');assert.equal(result.matches,1);
   assert.equal(result.requests,before?9:3);
   console.log(before?'BEFORE last-match search':'AFTER last-match search',name,result);continue;
  }
  if(before){
   await page.evaluate(async()=>{__test.state.query='fixture';await __test.loadItems();});await page.waitForTimeout(600);
   const observed=await page.evaluate(()=>({unfinished:__test.state.progressiveItemsLoading,matches:__test.state.files.length}));
   assert.equal(observed.unfinished,true);assert.ok(observed.matches<500);console.log('REPRODUCED viewport blocks search completion',name,{...observed,requests});continue;
  }
  const first=await search('fixture');assert.equal(first.matches,500);assert.equal(first.requests,3);assert.equal(first.decrypts,500);assert.ok(first.cards<500,'retain progressive DOM rendering');
  const repeat=await search('fixture 49');assert.equal(repeat.matches,11);assert.equal(repeat.requests,3);assert.equal(repeat.decrypts,0);
  console.log('PASS automatic complete search / metadata reuse / no plaintext query',name,{first,repeat});
  const cache=await page.evaluate(()=>__test.searchCacheSnapshot());assert.equal(cache.length,500);
  assert.deepEqual(Object.keys(cache[0]).sort(),['metadata','savedAt','signature']);assert.ok(!JSON.stringify(cache).includes('fileKey"'),'cache must not contain keys');
  // Every search still uses fresh server candidates: a removed/forbidden record cannot survive in results.
  records=records.slice(0,499);const removed=await search('fixture 499');assert.equal(removed.matches,0);assert.equal(removed.decrypts,0);
  // Tampering with an encrypted metadata version cannot reuse a previous decoded name.
  records[0]={...records[0],encryptedMetadata:'AAAA'};const changed=await search('fixture 0');assert.equal(changed.matches,0);assert.equal(changed.decrypts,1);
  for(const [field,value] of [['sessionCacheId','new-session'],['serviceLinkId','new-link'],['rootFolderId',2],['serviceAccountId','other-account']]){
   await page.evaluate(({field,value})=>{__test.state.session[field]=value;},{field,value});
   const result=await search('fixture');assert.equal(result.decrypts,499,field+' must separate metadata caches');
  }
  deny=true;const denied=await search('fixture');assert.equal(denied.matches,0);
  assert.equal(await page.evaluate(()=>__test.searchCacheSnapshot().length),0,'permission denial must clear retained search results and cache');deny=false;
  await page.evaluate(()=>{__test.state.crypto.folderKeys.clear();});const locked=await search('fixture');assert.equal(locked.matches,0,'cached names must require an authenticated file key');
  await page.evaluate(()=>{
   __test.state.session.sessionCacheId='cancel-in-flight';__test.state.crypto.folderKeys.set(1,researchFolderKey);
   const decrypt=TRoomCrypto.decryptFileMetadata;
   const gate=new Promise(resolve=>globalThis.releaseDecode=resolve);globalThis.decodeStarted=false;
   globalThis.TRoomCrypto={...TRoomCrypto,decryptFileMetadata:async(...args)=>{decodeStarted=true;await gate;return decrypt(...args);}};
   globalThis.pendingSearch=__test.loadItems();
  });
  await page.waitForFunction(()=>globalThis.decodeStarted);
  await page.evaluate(async()=>{__test.releaseSessionState();releaseDecode();await pendingSearch;});
  assert.equal(await page.evaluate(()=>__test.searchCacheSnapshot().length),0);
  assert.equal(await page.locator('.file-card').count(),0,'late decrypt must not restore UI after logout');
  console.log('PASS removed files, encrypted version, scope isolation, missing keys and logout',name);
 }finally{await browser.close();}
}}finally{await fixture.close();}
