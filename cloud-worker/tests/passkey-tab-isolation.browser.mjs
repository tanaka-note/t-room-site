import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {db,env,context} from './session-fixture.mjs';
const {chromium}=createRequire(new URL('../../diary-worker/package.json',import.meta.url))('playwright');
globalThis.window=globalThis;
await import('../public/vendor/argon2.umd.min.js');
await import('../public/crypto-vault.js');
const root=resolve(process.env.TCLOUD_TEST_SOURCE_ROOT || fileURLToPath(new URL('../../',import.meta.url)));
const prf=crypto.getRandomValues(new Uint8Array(32));
const accountKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const vault=await TRoomCrypto.createVault(accountKey);
const config={initialized:true,cryptoVersion:1,createdAt:'fixture',...vault.payload};
const adminEnvelope=await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey,config,prf);
const memberVault=await TRoomCrypto.createPasskeyClientVault(prf);
const rootKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const wrappedKey=await TRoomCrypto.wrapFolderKeyForIdentity(rootKey,memberVault.publicKeyJwk);
const fixtures={prf:[...prf],config,keys:{admin:{admin_private_prf:adminEnvelope},'folder-member':{client_private_prf:{encryptedPayload:memberVault.encryptedPayload,payloadIv:memberVault.payloadIv},folder_key_rsa:{wrappedKey}}}};
fixtures.accountKey = [...new Uint8Array(await crypto.subtle.exportKey('raw',accountKey))];
const mediaKey = await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const plainMedia = new TextEncoder().encode('local encrypted video fixture');
const encryptedMedia = await TRoomCrypto.encryptFileChunk(mediaKey,plainMedia,0);
fixtures.mediaKey = [...new Uint8Array(await crypto.subtle.exportKey('raw',mediaKey))];
fixtures.mediaFile = {id:1,name:'fixture.webm',mimeType:'video/webm',sizeBytes:plainMedia.length,chunkSizeBytes:1024,chunkCount:1,encryptedSizeBytes:encryptedMedia.length};
env.FILES.get = async (_key,options) => {
  const match = options?.range?.get('Range')?.match(/bytes=(\d+)-(\d+)/);
  const offset = Number(match?.[1] || 0), length = match ? Number(match[2])-offset+1 : encryptedMedia.length;
  return {size:encryptedMedia.length,range:match?{offset,length}:undefined,body:encryptedMedia.slice(offset,offset+length),httpEtag:'"fixture"',writeHttpMetadata(){}};
};
db.prepare(`INSERT INTO cloud_crypto_config(id,crypto_version,public_key_jwk,admin_private_cipher,admin_private_iv,recovery_private_cipher,recovery_private_iv) VALUES(1,1,?,?,?,?,?)`).run(JSON.stringify(config.publicKeyJwk),config.adminPrivateCipher,config.adminPrivateIv,config.recoveryPrivateCipher,config.recoveryPrivateIv);
let releaseSlow, slowStarted;
const requests=[];
const lifecycle=[];
const server=createServer(async(req,res)=>{
 const record={url:req.url,finished:false};lifecycle.push(record);res.on('finish',()=>{record.finished=true;record.status=res.statusCode;});
 try {
  const origin=`http://127.0.0.1:${server.address().port}`,url=new URL(req.url,origin);
  if(url.pathname.startsWith('/cloud/api/')) {
   const chunks=[];for await(const chunk of req) chunks.push(chunk);
   const response=await context.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})}),env,{waitUntil(){}});
   requests.push({path:url.pathname,status:response.status,expected:req.headers['x-tcloud-session']});
   if(url.searchParams.has('delayed')) {slowStarted?.();await new Promise(r=>{releaseSlow=r;});}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  let path=url.pathname==='/'||url.pathname==='/cloud/'?'cloud-worker/public/index.html':url.pathname==='/cloud/offline'?'cloud-worker/public/offline.html':url.pathname.startsWith('/cloud/')?'cloud-worker/public/'+url.pathname.slice(7):url.pathname.slice(1);
  if(path==='security/passkey-client.js') {res.setHeader('Content-Type','text/javascript');res.end('');return;}
  if(!path.startsWith('cloud-worker/public/')&&!path.startsWith('assets/')) {res.writeHead(404);res.end();return;}
  let data=readFileSync(resolve(root,path));
  if(path==='cloud-worker/public/cloud.js') {
   let source=data.toString().replace('document.addEventListener("DOMContentLoaded", initialize);','');
   source+=`\nbindEvents=()=>{}; restoreInstalledAppPortrait=async()=>{}; updateInstallButtons=()=>{}; restoreRememberedLogin=async()=>{}; reportCompletedAppUpdate=()=>{};
    globalThis.__fixtures=${JSON.stringify(fixtures)};
    globalThis.TRoomPasskeys={authenticate:async(_service,choose)=>{const links=['admin','folder-member'].map(accountId=>({id:'primary-admin-'+accountId,accountId,role:accountId==='admin'?'admin':'member',rootFolderId:accountId==='admin'?null:7}));const link=await choose(links);return {link,prfOutput:new Uint8Array(__fixtures.prf),handoff:{handoffToken:link.accountId,tcloudKey:__fixtures.keys[link.accountId]}};}};
    enterApp=async(session)=>{state.session=session;state.loginId=session.loginId;globalThis.TCloudSession?.bind(session,false);await prepareCryptoSession('',null,{prfOutput:new Uint8Array(__fixtures.prf),tcloudKey:__fixtures.keys[session.serviceAccountId]});document.querySelector('#account-name').textContent=session.role;};
    globalThis.__app={state,api,initialize,logout,prepareCryptoSession,uploadPartRequest,clearLegacyPasskeyAdminKeys:typeof clearLegacyPasskeyAdminKeys==='function'?clearLegacyPasskeyAdminKeys:null,saveCachedAdminKey,loadCachedAdminKey,openVaultCache};
    globalThis.__login=async(account)=>{globalThis.TCloudSession?.beginSelection();const session=await api('/passkey/handoff',{method:'POST',body:JSON.stringify({handoffToken:account})});await enterApp(session);return session;};
   `;
   data=Buffer.from(source);
  }
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.webmanifest':'application/manifest+json','.wasm':'application/wasm'})[extname(path)]||'application/octet-stream');res.end(data);
 }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const executablePath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const browserContext=await browser.newContext();
const origin=`http://127.0.0.1:${server.address().port}`;
const pageErrors=[];
let phase='start';
const watchdog=setTimeout(()=>{console.error('Browser test timed out:',phase);server.closeAllConnections();void browser.close();},120000);
watchdog.unref();
async function page(){const p=await browserContext.newPage();p.on('pageerror',e=>pageErrors.push(e.message));p.on('requestfailed',r=>lifecycle.push({failed:r.url(),reason:r.failure()}));await p.goto(origin+'/cloud/');await p.waitForFunction(()=>!!globalThis.__app);return p;}
async function cacheKeys(p){return p.evaluate(async()=>{const db=await __app.openVaultCache();return new Promise((resolve,reject)=>{const r=db.transaction('crypto-keys','readonly').objectStore('crypto-keys').getAllKeys();r.onsuccess=()=>{db.close();resolve(r.result)};r.onerror=()=>reject(r.error);});});}
try {
 const a=await page(), b=await page();
 let member=await a.evaluate(()=>__login('folder-member'));
 phase='resume selected member';
 if(!process.argv.includes('--reproduce')) {
  await a.reload();await a.waitForFunction(()=>!!globalThis.__app);await a.evaluate(()=>__app.initialize());
  member=await a.evaluate(()=>__app.state.session);
  assert.equal(member.role,'member');assert.equal(member.rootFolderId,7);
 }
 const admin=await b.evaluate(()=>__login('admin'));
 phase='new tab shared Cookie';
 if(!process.argv.includes('--reproduce')) {
  const newTab=await page();await newTab.evaluate(()=>__app.initialize());
  assert.equal(await newTab.evaluate(()=>__app.state.session),null,'new or upgraded tab cannot adopt a shared passkey Cookie without its own selection');await newTab.close();
 }
 if(process.argv.includes('--reproduce')) {
  const leaked=await a.evaluate(()=>__app.api('/items'));
  assert.deepEqual(leaked.folders.map(f=>f.id).sort(),[7,9]);
  const keys=await cacheKeys(b);assert.ok(keys.some(k=>k.startsWith('passkey:primary-admin:')));
  await a.reload();await a.waitForFunction(()=>!!globalThis.__app);await a.evaluate(()=>__app.initialize());
  assert.equal(await a.evaluate(()=>__app.state.session.role),'admin');
  console.log('BEFORE reproduced: member tab used admin Cookie, reload promoted to admin, passkey admin key persisted in IndexedDB');
 } else {
  phase='stale tabs and requests';
  assert.equal((await cacheKeys(b)).filter(k=>k.startsWith('passkey:')).length,0);
  await a.waitForFunction(()=>globalThis.__app && !__app.state.session);
  await a.reload();await a.waitForFunction(()=>!!globalThis.__app);await a.evaluate(()=>__app.initialize());
  assert.equal(await a.evaluate(()=>__app.state.session),null,'blocked tab must not adopt the new Cookie on reload');
  // The server check holds even with cross-tab notifications absent/bypassed.
  for(const [path,method] of [['/items','GET'],['/files/2/download','GET'],['/files/2/view','GET'],['/uploads/1/parts/1','PUT'],['/folders/9','PATCH']]) {
   const response=await browserContext.request.fetch(origin+'/cloud/api'+path,{method,headers:{'X-TCloud-Session':member.sessionCacheId,'Content-Type':'application/json'},...(method==='GET'?{}:{data:'{}'})});
   assert.equal(response.status(),419,path);
  }
  assert.equal((await browserContext.request.get(origin+'/cloud/api/items')).status(),419,'header omission fails closed for passkeys');
  await a.evaluate(()=>__login('folder-member'));await b.waitForFunction(()=>globalThis.__app && !__app.state.session);
  assert.equal((await browserContext.request.get(origin+'/cloud/api/items',{headers:{'X-TCloud-Session':admin.sessionCacheId}})).status(),419,'stale admin cannot adopt member Cookie');
  // Delay an already-authorized response across a Cookie switch.
  const started=new Promise(r=>{slowStarted=r;});
  const oldResult=a.evaluate(async()=>{try{await __app.api('/items?delayed=1');return 'applied';}catch{return 'blocked';}}).catch(()=> 'blocked');
  await started;await b.evaluate(()=>__login('admin'));releaseSlow();
  assert.equal(await oldResult,'blocked');
  await a.waitForFunction(()=>globalThis.__app && !__app.state.session);
  const active = await a.evaluate(()=>__login('folder-member'));
  phase='XHR and SW';
  const upload = await a.evaluate(async()=>{
    const upload=await __app.api('/uploads',{method:'POST',body:JSON.stringify({folderId:7,sizeBytes:1,cryptoVersion:1,encryptedMetadata:'AA',metadataIv:'AA',wrappedFileKey:'AA',fileKeyIv:'AA',encryptedSizeBytes:33,chunkSizeBytes:8388608,chunkCount:1})});
    const part=await __app.uploadPartRequest(`/uploads/${upload.id}/parts/1`,new Uint8Array(33));
    return {id:upload.id,part};
  });
  assert.equal(upload.part.partNumber,1,'real XHR upload remains usable');
  assert.ok(requests.some(r=>r.path===`/cloud/api/uploads/${upload.id}/parts/1`&&r.status===200&&r.expected===active.sessionCacheId));
  await b.waitForFunction(()=>globalThis.__app && !__app.state.session);
  await a.evaluate(async()=>{await navigator.serviceWorker.register('/cloud/media-worker.js',{scope:'/cloud/'});await navigator.serviceWorker.ready;});
  const media = await a.evaluate(async()=>TCloudMedia.registerMedia(__fixtures.mediaFile,await crypto.subtle.importKey('raw',new Uint8Array(__fixtures.mediaKey),{name:'AES-GCM'},false,['decrypt']),'/cloud/api/files/1/view'));
  const bytes = await a.evaluate(async url=>[...new Uint8Array(await (await fetch(url,{headers:{Range:'bytes=0-4'}})).arrayBuffer())],media.url);
  assert.deepEqual(bytes,[...plainMedia.slice(0,5)],'real SW decrypts encrypted Range');
  await b.evaluate(()=>TCloudMedia.clearMedia());
  assert.equal(await a.evaluate(async url=>(await fetch(url,{headers:{Range:'bytes=0-4'}})).status,media.url),206,'another tab cannot clear this playback registration');
  assert.ok(requests.some(r=>r.path==='/cloud/api/files/1/view'&&r.status===206&&r.expected===active.sessionCacheId));
  // Change only the Cookie: no storage event or BroadcastChannel notification.
  await browserContext.request.post(origin+'/cloud/api/passkey/handoff',{headers:{Origin:origin},data:{handoffToken:'admin'}});
  // Native XHR is bound even when the tab has not received a notification.
  const xhrBlocked=await a.evaluate(async id=>{try{await __app.uploadPartRequest(`/uploads/${id}/parts/1`,new Uint8Array(33));return false}catch{return true}},upload.id).catch(()=>true);
  assert.equal(xhrBlocked,true);
  // Use a separate bound tab to verify stale cached SW reads without relying
  // on the XHR's invalidation notification.
  await a.waitForFunction(()=>globalThis.__app && !__app.state.session);
  await a.evaluate(()=>__login('folder-member'));
  const cachedMedia=await a.evaluate(async()=>TCloudMedia.registerMedia(__fixtures.mediaFile,await crypto.subtle.importKey('raw',new Uint8Array(__fixtures.mediaKey),{name:'AES-GCM'},false,['decrypt']),'/cloud/api/files/1/view'));
  await a.evaluate(async url=>(await fetch(url,{headers:{Range:'bytes=0-4'}})).arrayBuffer(),cachedMedia.url);
  await browserContext.request.post(origin+'/cloud/api/passkey/handoff',{headers:{Origin:origin},data:{handoffToken:'admin'}});
  const staleMedia=await a.evaluate(async url=>{try{return (await fetch(url,{headers:{Range:'bytes=0-4'}})).status}catch{return 'blocked'}},cachedMedia.url).catch(()=> 'blocked');
  assert.ok([419,'blocked'].includes(staleMedia),'cached decrypted media rejects Cookie mismatch');
  await a.waitForFunction(()=>globalThis.__app && !__app.state.session);
  await b.evaluate(()=>__login('admin'));
  const cleanup = await b.evaluate(async()=>{
    const key=__app.state.crypto.adminPrivateKey, db=await __app.openVaultCache();
    await new Promise((resolve,reject)=>{const t=db.transaction('crypto-keys','readwrite'),s=t.objectStore('crypto-keys');s.put({privateKey:key,storedAt:1},'passkey:primary-admin:legacy');s.put({privateKey:key,storedAt:1},'admin@test:pw-preserved');s.put({cacheType:'folder',folderId:7},'folder-session:fixture:7');t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
    await __app.clearLegacyPasskeyAdminKeys();
    const cached=await __app.loadCachedAdminKey(__fixtures.config);
    await __app.saveCachedAdminKey(__fixtures.config,key);
    return {memberOrPasskeyRead:cached===null};
  });
  assert.equal(cleanup.memberOrPasskeyRead,true);
  phase='passkey logout';
  assert.deepEqual((await cacheKeys(b)).sort(),['admin@test:pw-preserved','folder-session:fixture:7']);
  await b.evaluate(()=>__app.logout()).catch(()=>{});
  await b.waitForFunction(()=>globalThis.__app && !__app.state.session);
  assert.deepEqual((await cacheKeys(b)).sort(),['admin@test:pw-preserved','folder-session:fixture:7'],'passkey logout preserves unrelated PW and folder cache');
  const pwResult=await b.evaluate(async()=>{
    TCloudSession.beginSelection();
    const session=await __app.api('/login',{method:'POST',body:JSON.stringify({loginId:'admin@test',authProof:'local-proof'})});
    __app.state.session=session;__app.state.loginId=session.loginId;
    const accountKey=await crypto.subtle.importKey('raw',new Uint8Array(__fixtures.accountKey),{name:'AES-GCM'},false,['decrypt','encrypt']);
    await __app.prepareCryptoSession('local-password',accountKey);
    const loaded=await __app.loadCachedAdminKey(__app.state.crypto.config);
    __app.state.crypto.adminPrivateKey=null;
    await __app.prepareCryptoSession('');
    return {cached:loaded?.type==='private',resumed:__app.state.crypto.adminPrivateKey?.type==='private'};
  });
  assert.deepEqual(pwResult,{cached:true,resumed:true});
  console.log('two real browser tabs: both directions, reload, stale API/Range/upload, in-flight responses, real SW Range/cache, selective IndexedDB cleanup and PW key resume passed');
 }
} catch(error) {
 console.error('Browser diagnostics:',JSON.stringify({pageErrors,lifecycle:lifecycle.slice(-50),pages:await Promise.all(browserContext.pages().map(async p=>({url:p.url(),title:await p.title().catch(()=>''),state:await p.evaluate(()=>({loaded:!!globalThis.__app,role:globalThis.__app?.state.session?.role,blocked:globalThis.TCloudSession?.isBlocked(),body:document.body.innerText.slice(0,200)})).catch(()=>null)}))),requests:requests.slice(-12)}));throw error;
} finally {clearTimeout(watchdog);releaseSlow?.();server.closeAllConnections();await browser.close();await new Promise(r=>server.close(r));db.close();}
