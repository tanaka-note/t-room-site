import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const fixture=await startUIFixture();
try { for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}}), writes=[];
  const favorites={fileIds:new Set(),folderIds:new Set()};
  const files=[{id:1,folderId:8,name:'photo.png',mimeType:'image/png',mediaKind:'image',cryptoVersion:0,sizeBytes:100},{id:2,folderId:8,name:'document.txt',mimeType:'text/plain',mediaKind:'document',cryptoVersion:0,sizeBytes:100}];
  const folders=[{id:8,parentId:7,name:'Saved folder',cryptoVersion:0,isUnlocked:true,fileCount:2,folderCount:0}];
  await page.route('**/cloud/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let data={};
   if(url.pathname.endsWith('/favorites/status')){const b=req.postDataJSON();data={fileIds:b.fileIds.filter(id=>favorites.fileIds.has(id)),folderIds:b.folderIds.filter(id=>favorites.folderIds.has(id))};}
   else if(url.pathname.endsWith('/favorites')){
    if(req.method()==='GET')data={files:files.filter(f=>favorites.fileIds.has(f.id)),folders:folders.filter(f=>favorites.folderIds.has(f.id))};
    else {const b=req.postDataJSON();writes.push({method:req.method(),...b});for(const kind of ['fileIds','folderIds'])for(const id of b[kind])favorites[kind][req.method()==='DELETE'?'delete':'add'](id);data={ok:true};}
   } else if(url.pathname.endsWith('/items'))data={files,folders:url.searchParams.has('folderId')?[]:folders,breadcrumbs:url.searchParams.has('folderId')?[{id:7,name:'Storage root',isUnlocked:true,cryptoVersion:0}]:[],folder:null};
   else if(url.pathname.endsWith('/shares'))data={shares:[]};
   else if(url.pathname.endsWith('/conflicts'))data={files:[],folders:[],groups:[]};
   await route.fulfill({json:data});
  });
  await preparePage(page,fixture.origin,2);
  await page.evaluate(async({files,folders})=>{__test.state.files=files;__test.state.folders=folders;__test.renderItems();},{files,folders});
  assert.deepEqual(await page.locator('.sidebar nav button').allTextContents().then(a=>a.map(s=>s.trim())),['フォルダ','写真','動画','お気に入り','音声','書類','ゴミ箱','アカウント']);
  // One batch for mixed file/folder selection; repeated click cannot duplicate.
  await page.locator('.file-card[data-file-id="1"] .file-select-button').click();
  await page.locator('.folder-select-button').click();
  await page.waitForFunction(()=>!document.querySelector('#selection-favorite').disabled);
  assert.ok((await page.locator('#selection-favorite').textContent()).includes('追加'));
  await page.locator('#selection-favorite').click();
  await page.waitForFunction(()=>document.querySelector('#selection-favorite').textContent.includes('削除'));
  assert.equal(writes.length,1);assert.deepEqual(writes[0],{method:'POST',fileIds:[1],folderIds:[8]});
  await page.locator('.file-card[data-file-id="2"] .file-select-button').click();
  await page.waitForFunction(()=>!document.querySelector('#selection-favorite').disabled);
  assert.ok((await page.locator('#selection-favorite').textContent()).includes('追加'),'mixed selection offers add');
  await page.locator('.sidebar [data-view="favorites"]').click();
  assert.equal(await page.evaluate(()=>history.state.view),'favorites','reload must retain the virtual view');
  await page.waitForFunction(()=>__test.state.view==='favorites'&&__test.state.files.length===1&&__test.state.folders.length===1,{},{timeout:5000}).catch(async e=>{console.log(await page.evaluate(()=>({view:__test.state.view,files:__test.state.files.length,folders:__test.state.folders.length,notice:document.querySelector('#notice')?.textContent,history:history.state})));throw e;});
  await page.locator('.folder-open-button').click();
  await page.waitForFunction(()=>__test.state.folderId===8);
  await page.goBack();
  await page.waitForFunction(()=>__test.state.view==='favorites'&&__test.state.files.length===1);
  await page.locator('.file-select-button').click();
  await page.waitForFunction(()=>!document.querySelector('#selection-favorite').disabled);
  assert.ok((await page.locator('#selection-favorite').textContent()).includes('削除'));
  await page.locator('#selection-favorite').click();
  await page.waitForFunction(()=>__test.state.files.length===0);
  assert.equal(writes.at(-1).method,'DELETE');
  await page.locator('.sidebar [data-view="account"]').click();
  assert.equal(await page.evaluate(()=>history.state.view),'account');
  await page.waitForFunction(()=>!document.querySelector('#account-view').hidden);
  assert.equal(await page.locator('#account-dialog').evaluate(d=>d.open),false);
  assert.equal(await page.locator('#account-view #device-cache-limit').count(),1);
  await page.locator('#account-view [data-view="shares"]').click();
  await page.waitForFunction(()=>__test.state.view==='shares');
  await page.locator('.sidebar [data-view="account"]').click();
  await page.locator('#account-view [data-view="conflicts"]').click();
  await page.waitForFunction(()=>__test.state.view==='conflicts');
  await page.locator('.sidebar [data-view="all"]').click();
  await page.locator('.folder-open-button').click();
  await page.waitForFunction(()=>__test.state.folderId===8);
  await page.evaluate(()=>__test.state.crypto.folderKeys.set(7,__thumb.key));
  await page.locator('.sidebar [data-view="account"]').click();
  await page.waitForFunction(()=>__test.state.view==='account'&&__test.state.breadcrumbs.length===1);
  assert.equal(await page.evaluate(()=>__test.state.folderId),8);
  if(await page.evaluate(()=>TCloudOffline.supported())){
   await page.waitForFunction(()=>!document.querySelector('#device-storage-values').hidden);
   assert.ok((await page.locator('#device-storage-scope').textContent()).includes('Storage root'));
  } else assert.ok((await page.locator('#device-storage-scope').textContent()).includes('対応していません'));
  for(const width of [320,390,430]){
   await page.setViewportSize({width,height:740});
   if(width===320){
    await page.locator('#mobile-account-button').click();
    await page.locator('#account-dialog .dialog-close').click();
    await page.waitForFunction(()=>document.querySelector('#account-view').contains(document.querySelector('#account-content')));
   }
   assert.deepEqual(await page.locator('.mobile-nav button').allTextContents().then(a=>a.map(s=>s.trim())),['フォルダ','写真','動画','お気に入り','ゴミ箱','アカウント']);
   const rects=await page.locator('.mobile-nav button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right};}));
   assert.ok(rects.every(r=>r.x>=0&&r.right<=width&&r.y===rects[0].y));
   await page.locator('#mobile-account-button').click();
   assert.ok(await page.locator('#account-dialog').evaluate(d=>d.open));
   assert.equal(await page.locator('#account-dialog #device-cache-limit').count(),1);
   await page.locator('#account-dialog [data-view="conflicts"]').click();
   assert.equal(await page.locator('#account-dialog').evaluate(d=>d.open),false);
  }
  for(const role of ['member','subadmin']){
   await page.evaluate(role=>{__test.state.session={...__test.state.session,role,serviceAccountId:role,sessionCacheId:role};},role);
   await page.locator('#mobile-account-button').click();
   assert.equal(await page.locator('#account-content [data-view="shares"]').isVisible(),false);
   assert.equal(await page.locator('#batch-rename-action').isVisible(),false);
   await page.locator('#account-dialog .dialog-close').click();
  }
  await page.evaluate(()=>__test.releaseSessionState());
  assert.equal(await page.locator('.file-card').count(),0);
  assert.equal(writes.length,2,'account navigation and logout make no favorite writes');
  console.log('PASS',name,'batch file/folder favorites, state labels, folder/back, desktop account, mobile six-item layout, shares/conflicts navigation, role gates, logout');
 }finally{await browser.close();}
}}finally{await fixture.close();}
