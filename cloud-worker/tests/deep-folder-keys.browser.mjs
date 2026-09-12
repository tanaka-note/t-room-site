import assert from 'node:assert/strict';
import {engines,root,startUIFixture,preparePage} from './ui-fixture.mjs';
const before=process.argv.includes('--reproduce'),fixture=await startUIFixture(process.env.TCLOUD_TEST_SOURCE_ROOT||root);
try{for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});try{
  const page=await browser.newPage();await preparePage(page,fixture.origin,0);
  const records=await page.evaluate(async()=>{
   const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
   const parent=await TRoomCrypto.createFolderPackage('parent','',rsa.publicKey);
   const child=await TRoomCrypto.createFolderPackage('child','',rsa.publicKey,parent.folderKey);
   const file=await TRoomCrypto.createFilePackage({name:'fixture-deep.png',type:'image/png',size:100,lastModified:1},child.folderKey,'image');
   __test.state.crypto.adminPrivateKey=rsa.privateKey;__test.state.crypto.publicKey=rsa.publicKey;__test.state.crypto.folderKeys.clear();__test.state.folderId=2;
   return {folder:{id:2,name:'child'},folders:[],files:[{id:123,folderId:2,cryptoVersion:1,...file.payload}],breadcrumbs:[{id:1,name:'parent',cryptoVersion:1,...parent.payload},{id:2,parentId:1,name:'child',cryptoVersion:1,...child.payload}]};
  });
  await page.route('**/cloud/api/**',route=>route.fulfill({json:records}));
  await page.evaluate(()=>__test.loadItems());
  const result=await page.evaluate(()=>({name:__test.state.files[0]?.name,key:!!__test.state.files[0]?.fileKey}));
  assert.equal(result.key,!before);if(!before)assert.equal(result.name,'fixture-deep.png');
  console.log(before?'REPRODUCED file hydration precedes breadcrumb keys':'PASS deep folder refresh key ordering',name,result);
 }finally{await browser.close();}
}}finally{await fixture.close();}
