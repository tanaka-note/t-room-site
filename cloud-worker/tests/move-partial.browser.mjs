import assert from 'node:assert/strict';
import {engines, startUIFixture, preparePage} from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({headless:true,...launch});
  try { for (const mobile of [false,true]) { for (const unknown of [false,true]) {
    const context = await browser.newContext(mobile ? {viewport:{width:390,height:844},hasTouch:true,isMobile:true} : {});
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror',error=>errors.push(error.message));
    let records = new Map(), readBlocked = unknown, fail = true, release;
    const started = new Promise(resolve=>{release=resolve;});
    let signalStarted;
    const requestStarted = new Promise(resolve=>{signalStarted=resolve;});
    await page.route('**/cloud/api/**',async route=>{
      const url = new URL(route.request().url()), id = Number(url.pathname.split('/').at(-1));
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();writes.push({id,body});
        if (!unknown && id===401 && fail) {signalStarted();await started;}
        if (!unknown && id===402 && fail) {await route.abort('failed');return;}
        records.set(id,{...records.get(id),...body});
        if (id===403 && fail) {await route.abort('failed');return;}
        await route.fulfill({json:{ok:true}});return;
      }
      if (/\/files\/\d+$/.test(url.pathname)) {
        if(readBlocked){await route.abort('failed');return;}
        await route.fulfill({json:{file:records.get(id)}});return;
      }
      if(url.pathname.endsWith('/move-destinations')){
        await route.fulfill({json:{folders:[{id:7,parentId:null,name:'Atsushi'},{id:9,parentId:7,name:'Source'},{id:101,parentId:null,name:'NAS'}]}});return;
      }
      const folderId = Number(url.searchParams.get('folderId'));
      await route.fulfill({json:{files:[...records.values()].filter(f=>f.folderId===folderId),folders:[],
        breadcrumbs:folderId===101?[{id:101,parentId:null,name:'NAS'}]:[{id:7,parentId:null,name:'Atsushi'},{id:9,parentId:7,name:'Source'}],
        nextFileOffset:null,nextFolderOffset:null}});
    });
    try {
      await preparePage(page,fixture.origin,0);
      const initial = await page.evaluate(async()=>{
        const state = __test.state;
        const sourceKey = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
        const destinationKey = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
        state.session={role:'member',authMethod:'passkey',identityId:'local',serviceAccountId:'folder-member',serviceLinkId:'source',rootFolderId:7,
          sessionCacheId:'partial-fixture',canEditFiles:true,canEditFolders:true,canRenameUnlockedItems:true,
          folderScopes:[{serviceLinkId:'source',rootFolderId:7},{serviceLinkId:'nas',rootFolderId:101}]};
        state.folderId=9;state.crypto.folderKeys=new Map([[7,sourceKey],[9,sourceKey],[101,destinationKey]]);
        state.breadcrumbs=[{id:7,parentId:null,name:'Atsushi'},{id:9,parentId:7,name:'Source'}];
        const records=[];globalThis.__partialKeys=new Map();globalThis.__partialDestinationKey=destinationKey;
        for(const id of [401,402,403]){
          const encrypted=await TRoomCrypto.createFilePackage({name:`local-${id}.mp4`,type:'video/mp4',size:5,lastModified:1},sourceKey,'video');
          const file={id,folderId:9,name:`local-${id}.mp4`,cryptoVersion:1,...encrypted.payload};
          records.push(file);__partialKeys.set(id,encrypted.fileKey);
          rememberSelectedRecord('file',{...file,fileKey:encrypted.fileKey});
        }
        state.files=[];state.folders=[];
        globalThis.TCloudDisplayCache={...TCloudDisplayCache,supported:()=>false};
        return records;
      });
      records=new Map(initial.map(f=>[f.id,f]));
      await page.evaluate(()=>openMoveDialog());
      await page.locator('#move-breadcrumbs [data-folder-id="root"]').click();
      await page.locator('#move-folder-list [data-folder-id="101"]').click();
      await page.locator('#move-submit').click();
      if(!unknown){
        await requestStarted;
        await page.keyboard.press('Escape');
        await page.locator('#move-form').dispatchEvent('submit');
        assert.equal(await page.locator('#move-dialog').evaluate(d=>d.open),true);
        assert.equal(writes.length,1,'duplicate submit and Escape do not interrupt an in-flight move');
        release();
      }
      await page.waitForFunction(()=>document.querySelector('#move-submit').textContent==='残りを確認して再試行');
      assert.equal(await page.locator('#move-dialog').evaluate(d=>d.open),true);
      assert.equal(await page.locator('#move-dialog .move-picker').evaluate(p=>p.inert),true);
      const remaining=await page.evaluate(()=>selectedItems().files.map(f=>f.id));
      assert.deepEqual(remaining,[unknown?403:402]);
      assert.match(await page.locator('#move-copy').innerText(),unknown?/結果未確認1件/:/残り1件/);
      assert.equal(await page.locator('.file-card').count(),unknown?0:1,'the refreshed source listing contains only files still there');
      const sent=writes.length;
      if(unknown){
        await page.locator('#move-submit').click();
        await page.waitForFunction(()=>!document.querySelector('#move-submit').disabled);
        assert.equal(writes.length,sent,'unknown result is not resent while status reads fail');
      }
      fail=false;readBlocked=false;
      await page.locator('#move-submit').click();
      await page.waitForFunction(()=>!document.querySelector('#move-dialog').open);
      await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('3件を移動しました'));
      assert.equal(writes.length,sent+(unknown?0:1));
      assert.match(await page.locator('#notice').innerText(),/3件を移動しました/);
      assert.equal(await page.locator('.file-card').count(),0);
      assert.equal([...records.values()].filter(f=>f.folderId===9).length,0);
      assert.equal([...records.values()].filter(f=>f.folderId===101).length,3);
      assert.equal(await page.evaluate(async records=>{
        for(const record of records){
          const key=await TRoomCrypto.unlockFileKey(record,__partialDestinationKey);
          const raw=await crypto.subtle.exportKey('raw',key), expected=await crypto.subtle.exportKey('raw',__partialKeys.get(record.id));
          if(new Uint8Array(raw).toString()!==new Uint8Array(expected).toString())return false;
        }return true;
      },[...records.values()]),true,'every moved key remains usable after retry/reconciliation');
      assert.deepEqual(errors,[]);
      console.log('PASS partial moves',name,{mobile,unknown,retained:true,verifiedRetry:true,duplicateSubmitBlocked:true});
    } finally {release?.();await context.close();}
  }}} finally {await browser.close();}
}} finally {await fixture.close();}
