import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {attachPasskeyLedger,seedMultiFolderHandoff} from './passkey-ledger-fixture.mjs';
import {db,securityDb,env,context} from './session-fixture.mjs';
const RealDate=Date;
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
const secondRootKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
const folderScopes=[{serviceLinkId:'primary-admin-folder-member',rootFolderId:7},{serviceLinkId:'primary-admin-second',rootFolderId:9}];
fixtures.keys['cloud-member']={client_private_prf:fixtures.keys['folder-member'].client_private_prf,folder_keys_rsa:[{...folderScopes[0],wrappedKey},{...folderScopes[1],wrappedKey:await TRoomCrypto.wrapFolderKeyForIdentity(secondRootKey,memberVault.publicKeyJwk)}]};
fixtures.rootProofs=await Promise.all([[7,rootKey],[9,secondRootKey]].map(async([id,key])=>{const iv=crypto.getRandomValues(new Uint8Array(12));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('folder '+id));return {id,iv:[...iv],cipher:[...new Uint8Array(cipher)]}}));
const redeem=env.SECURITY.redeemHandoff,validate=env.SECURITY.validatePasskeySession;
env.SECURITY.redeemHandoff=async token=>token==='cloud-member'?{identityId:'primary-admin',credentialId:'credential',serviceLinkId:folderScopes[0].serviceLinkId,serviceAccountId:'folder-member',cloudRootFolderId:7,displayLabel:'通常利用',sessionEpoch:1,cloudScopeId:'multi-snapshot',folderScopes}:redeem(token);
env.SECURITY.validatePasskeySession=async input=>input.cloudScopeId||input.folderScopes?{valid:(!input.cloudScopeId||input.cloudScopeId==='multi-snapshot'),folderScopes:input.folderScopes||folderScopes}:validate(input);
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
  // This fixture drives SW registration explicitly; the updater has a separate
  // browser suite and would otherwise race this test's instrumented startup.
  if(path==='security/passkey-client.js'||path==='assets/pwa-auto-update.js') {res.setHeader('Content-Type','text/javascript');res.end('');return;}
  if(!path.startsWith('cloud-worker/public/')&&!path.startsWith('assets/')) {res.writeHead(404);res.end();return;}
  let data=readFileSync(resolve(root,path));
  if(path==='cloud-worker/public/cloud.js') {
   let source=data.toString().replace('document.addEventListener("DOMContentLoaded", initialize);','');
   source+=`\nbindEvents=()=>{}; restoreInstalledAppPortrait=async()=>{}; updateInstallButtons=()=>{}; restoreRememberedLogin=async()=>{}; reportCompletedAppUpdate=()=>{};
    globalThis.__fixtures=${JSON.stringify(fixtures)};
    globalThis.__authCalls=0;globalThis.TRoomPasskeys={authenticate:async(_service,choose)=>{__authCalls++;const links=['admin','folder-member'].map(accountId=>({id:'primary-admin-'+accountId,accountId,role:accountId==='admin'?'admin':'member',rootFolderId:accountId==='admin'?null:7}));if(state.session?.folderScopes) links.push({id:'primary-admin-second',accountId:'folder-member',role:'member',rootFolderId:9});const link=await choose(links);return {link,prfOutput:new Uint8Array(__fixtures.prf),handoff:{handoffToken:link.id==='cloud-member'?'cloud-member':link.accountId,tcloudKey:__fixtures.keys[link.id==='cloud-member'?'cloud-member':link.accountId]}};}};
    enterApp=async(session,_password,_accountKey,passkeyContext)=>{state.session=session;state.loginId=session.loginId;globalThis.TCloudSession?.bind(session,false);await prepareCryptoSession('',null,passkeyContext||{prfOutput:new Uint8Array(__fixtures.prf),tcloudKey:__fixtures.keys[session.folderScopes?'cloud-member':session.serviceAccountId]});document.querySelector('#account-name').textContent=session.role;};
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
const profile=mkdtempSync(join(tmpdir(),'tcloud-passkey-'));
const launchOptions={headless:true,...(executablePath?{executablePath}:{})};
let browserContext=await chromium.launchPersistentContext(profile,launchOptions);
const browser={close:()=>browserContext.close()};
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
  assert.equal(await newTab.evaluate(()=>__app.state.session.sessionCacheId),admin.sessionCacheId,'new tab resumes only the current server session and its exactly bound opaque cache');assert.equal(await newTab.evaluate(()=>__authCalls),0);await newTab.close();
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
  for(const [path,method] of [['/items','GET'],['/items?searchCandidates=1','GET'],['/files/2/download','GET'],['/files/2/view','GET'],['/uploads/1/parts/1','PUT'],['/folders/9','PATCH']]) {
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
  assert.deepEqual((await cacheKeys(b)).filter(k=>!k.startsWith('passkey-session:')).sort(),['admin@test:pw-preserved','folder-session:fixture:7']);
  const loggedOutId=await b.evaluate(()=>__app.state.session.sessionCacheId);
  await b.evaluate(()=>__app.logout()).catch(()=>{});
  await b.waitForFunction(()=>globalThis.__app && !__app.state.session);
  assert.ok(!(await cacheKeys(b)).includes('passkey-session:'+loggedOutId),'logout deletes its own passkey cache');
  assert.deepEqual((await cacheKeys(b)).filter(k=>!k.startsWith('passkey-session:')).sort(),['admin@test:pw-preserved','folder-session:fixture:7'],'passkey logout preserves unrelated PW and folder cache');
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
  phase='real persistent browser restart';
  for(const account of ['admin','folder-member','cloud-member']) {
    const activePage=await page();
    const active=await activePage.evaluate(account=>__login(account),account);
    const before=requests.filter(r=>r.path==='/cloud/api/passkey/handoff').length;
    await activePage.reload();await activePage.waitForFunction(()=>!!globalThis.__app);await activePage.evaluate(()=>__app.initialize());
    assert.equal(await activePage.evaluate(()=>__app.state.session.sessionCacheId),active.sessionCacheId);
    assert.equal(await activePage.evaluate(()=>__authCalls),0);
    if(account==='cloud-member') assert.deepEqual(await activePage.evaluate(()=>[...__app.state.crypto.folderKeys.keys()]),[7,9]);
    // Close all tabs and the entire browser, then launch a new process/profile.
    for(const p of browserContext.pages())await p.close();await browserContext.close();
    browserContext=await chromium.launchPersistentContext(profile,launchOptions);
    const reboot=await page();await reboot.evaluate(()=>__app.initialize());
    assert.equal(await reboot.evaluate(()=>__app.state.session.sessionCacheId),active.sessionCacheId);
    assert.equal(await reboot.evaluate(()=>__authCalls),0);
    assert.equal(requests.filter(r=>r.path==='/cloud/api/passkey/handoff').length,before);
    const stored=await reboot.evaluate(async()=>{const db=await __app.openVaultCache();return new Promise(r=>{const q=db.transaction('crypto-keys','readonly').objectStore('crypto-keys').get('passkey-session:'+__app.state.session.sessionCacheId);q.onsuccess=()=>{db.close();r({extractable:q.result.privateKey.extractable,type:q.result.privateKey.type,fields:Object.keys(q.result).sort()})}})});
    assert.equal(stored.extractable,false);assert.equal(stored.type,'private');
    assert.deepEqual(stored.fields,['binding','cacheType','expiresAt','privateKey','sessionCacheId','wrappedFolderKeys']);
    if(account==='cloud-member') {
      assert.deepEqual(await reboot.evaluate(()=>[...__app.state.crypto.folderKeys.keys()]),[7,9]);
      assert.deepEqual(await reboot.evaluate(()=>Promise.all(__fixtures.rootProofs.map(async proof=>new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(proof.iv)},__app.state.crypto.folderKeys.get(proof.id),new Uint8Array(proof.cipher)))))),['folder 7','folder 9'],'each distinct wrapped folder key really decrypts its own folder after restart');
      // A successful protected API really renews the Worker Cookie and then IndexedDB.
      await new Promise(resolve=>setTimeout(resolve,1100));
      await reboot.evaluate(()=>__app.api('/items'));
      const renewed=await reboot.evaluate(()=>__app.state.session.expiresAt);
      assert.ok(renewed>active.expiresAt);
      await reboot.waitForFunction(expiresAt=>new Promise(async resolve=>{const db=await __app.openVaultCache();const q=db.transaction('crypto-keys','readonly').objectStore('crypto-keys').get('passkey-session:'+__app.state.session.sessionCacheId);q.onsuccess=()=>{db.close();resolve(q.result.expiresAt===expiresAt)}}),renewed);
      assert.equal(await reboot.evaluate(()=>__app.state.session.sessionCacheId),active.sessionCacheId);

    }
  }
  phase='actual 26-hour rolling session after scheduled handoff cleanup';
  const savedSecurity={...env.SECURITY};
  const continuationDb=attachPasskeyLedger(env,{realValidation:true});
  let rollingClock=RealDate.now();const rollingStart=rollingClock;
  const RollingDate=class extends RealDate {constructor(...args){super(...(args.length?args:[rollingClock]));}static now(){return rollingClock}};
  globalThis.Date=RollingDate;context.Date=RollingDate;
  try {
    const scopes=seedMultiFolderHandoff(continuationDb);
    const continued=await page();
    await continued.evaluate(now=>{globalThis.__rollingClock=now;const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[globalThis.__rollingClock]));}static now(){return globalThis.__rollingClock}}},rollingClock);
    const login=await continued.evaluate(()=>__login('cloud-member'));
    const startedAt=continuationDb.prepare('SELECT started_at FROM security_active_sessions').get().started_at;
    const before=requests.filter(r=>r.path==='/cloud/api/passkey/handoff').length;
    for(const hour of [10,20]) {
      rollingClock=rollingStart+hour*3600000;
      await continued.evaluate(now=>{__rollingClock=now},rollingClock);
      await continued.mouse.click(5,5); // Trusted foreground interaction.
      await continued.evaluate(()=>__app.api('/items'));
      assert.equal(await continued.evaluate(()=>__app.state.session.sessionCacheId),login.sessionCacheId);
    }
    rollingClock=rollingStart+26*3600000;
    continuationDb.prepare('DELETE FROM security_handoffs WHERE expires_at < ?').run(Math.floor(rollingClock/1000)-86400);
    assert.equal(continuationDb.prepare('SELECT count(*) n FROM security_handoffs').get().n,0);
    await browserContext.addInitScript(now=>{const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now}}},rollingClock);
    await continued.reload();await continued.waitForFunction(()=>!!globalThis.__app);await continued.evaluate(()=>__app.initialize());
    assert.equal(await continued.evaluate(()=>__app.state.session.sessionCacheId),login.sessionCacheId);
    assert.deepEqual(await continued.evaluate(()=>__app.state.session.folderScopes),scopes);
    assert.equal(await continued.evaluate(()=>__authCalls),0);
    assert.equal(requests.filter(r=>r.path==='/cloud/api/passkey/handoff').length,before);
    assert.deepEqual(await continued.evaluate(()=>Promise.all(__fixtures.rootProofs.map(async proof=>new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(proof.iv)},__app.state.crypto.folderKeys.get(proof.id),new Uint8Array(proof.cipher)))))),['folder 7','folder 9']);
    assert.equal(continuationDb.prepare('SELECT started_at FROM security_active_sessions').get().started_at,startedAt);
    await continued.mouse.click(5,5);await continued.evaluate(()=>__app.api('/items'));
    assert.equal(continuationDb.prepare('SELECT cloud_folder_scopes FROM security_active_sessions').get().cloud_folder_scopes,JSON.stringify(scopes));
    await continued.evaluate(()=>__app.logout());
    console.log('PASS browser + actual Security SQL: 26-hour rolling after handoff cleanup, same session/start/scopes, both folders decrypt, WebAuthn/handoff 0');
  }finally {
    globalThis.Date=RealDate;context.Date=RealDate;Object.assign(env.SECURITY,savedSecurity);continuationDb.close();
    for(const p of browserContext.pages())await p.close();await browserContext.close();browserContext=await chromium.launchPersistentContext(profile,launchOptions);
  }
  phase='expired and revoked session cache deletion after real browser restart';
  for(const reason of ['expired','cookie-expired','revoked','version','epoch','logout']) {
    const activePage=await page();const active=await activePage.evaluate(()=>__login('cloud-member'));
    const originalValidate=env.SECURITY.validatePasskeySession;
    const version=env.SESSION_VERSION;
    for(const p of browserContext.pages())await p.close();await browserContext.close();
    if(reason==='expired'||reason==='cookie-expired') {
      const expired=active.expiresAt+1;
      // Advance both Worker and browser clocks by more than twelve hours.
      const OriginalDate=Date;globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[expired*1000]));}static now(){return expired*1000}};context.Date=globalThis.Date;
    } else if(reason==='version') env.SESSION_VERSION='changed';
    else if(reason==='epoch') securityDb.exec("UPDATE security_active_sessions SET passkey_session_epoch=2");
    else if(reason==='logout') securityDb.exec("UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP");
    else env.SECURITY.validatePasskeySession=async()=>({valid:false});
    browserContext=await chromium.launchPersistentContext(profile,launchOptions);
    if(reason==='expired'||reason==='cookie-expired') await browserContext.addInitScript(epoch=>{const OriginalDate=Date;globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[epoch]));}static now(){return epoch}}},(active.expiresAt+1)*1000);
    if(reason==='cookie-expired') await browserContext.clearCookies();
    const reboot=await page();await reboot.evaluate(()=>__app.initialize());
    assert.equal(await reboot.evaluate(()=>__app.state.session),null,reason);
    assert.ok(!(await cacheKeys(reboot)).includes('passkey-session:'+active.sessionCacheId),reason+' cache deleted before unlock');
    assert.equal(await reboot.evaluate(()=>__authCalls),0,reason+' must not authenticate automatically');
    if(reason==='expired') {globalThis.Date=RealDate;context.Date=RealDate;for(const p of browserContext.pages())await p.close();await browserContext.close();browserContext=await chromium.launchPersistentContext(profile,launchOptions);}
    env.SECURITY.validatePasskeySession=originalValidate;env.SESSION_VERSION=version;
  }
  phase='real IndexedDB corruption and unavailable fallback';
  const recovery=await page();await recovery.evaluate(()=>__login('cloud-member'));
  const originalId=await recovery.evaluate(()=>__app.state.session.sessionCacheId);
  await recovery.evaluate(async()=>{const db=await __app.openVaultCache();await new Promise((resolve,reject)=>{const t=db.transaction('crypto-keys','readwrite'),s=t.objectStore('crypto-keys'),key='passkey-session:'+__app.state.session.sessionCacheId;const q=s.get(key);q.onsuccess=()=>s.put({...q.result,privateKey:'corrupt'},key);t.oncomplete=resolve;t.onerror=()=>reject(t.error)});db.close()});
  await recovery.reload();await recovery.waitForFunction(()=>!!globalThis.__app);await recovery.evaluate(()=>__app.initialize());
  assert.equal(await recovery.evaluate(()=>__authCalls),1);
  assert.notEqual(await recovery.evaluate(()=>__app.state.session.sessionCacheId),originalId);
  const missing=await page();await missing.evaluate(()=>{Object.defineProperty(globalThis,'indexedDB',{value:undefined,configurable:true})});
  await missing.evaluate(()=>__app.initialize());
  assert.equal(await missing.evaluate(()=>__authCalls),1);
  assert.ok(await missing.evaluate(()=>__app.state.session));
  console.log('two real browser tabs: both directions, reload, stale API/Range/upload, in-flight responses, real SW Range/cache, selective IndexedDB cleanup, multi-folder reload/restart without WebAuthn/handoff, actual rolling cache expiry, expiry/revoke/version/epoch/logout cache deletion after browser restart, cache corruption/unavailability fallback and PW key resume passed');
 }
} catch(error) {
 console.error('Browser diagnostics:',JSON.stringify({pageErrors,lifecycle:lifecycle.slice(-50),pages:await Promise.all(browserContext.pages().map(async p=>({url:p.url(),title:await p.title().catch(()=>''),state:await p.evaluate(()=>({loaded:!!globalThis.__app,role:globalThis.__app?.state.session?.role,blocked:globalThis.TCloudSession?.isBlocked(),body:document.body.innerText.slice(0,200)})).catch(()=>null)}))),requests:requests.slice(-12)}));throw error;
} finally {clearTimeout(watchdog);releaseSlow?.();server.closeAllConnections();await browser.close();await new Promise(r=>server.close(r));db.close();if(profile.startsWith(join(tmpdir(),'tcloud-passkey-')))rmSync(profile,{recursive:true,force:true});}
