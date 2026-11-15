import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {encryptedFixture} from './encryption-fixture.mjs';
import {keyBundle,publicKey} from '../src/keys.js';
const require=createRequire(import.meta.url),engine=require('../../diary-worker/node_modules/playwright')[process.env.TROOM_BROWSER||'chromium'];
const f=await encryptedFixture();f.seed('Synthetic private browser entry');
// Exercise the reused T-Cloud PRF envelope and its non-extractable RSA cache
// in Chromium and WebKit; actual WebAuthn is covered in Security's CDP test.
globalThis.window=globalThis;await import('../../cloud-worker/public/crypto-vault.js');
const reused=await TRoomCrypto.createPasskeyClientVault(f.prf);
const wrapped=await f.client.wrapMaster(f.master,reused.publicKeyJwk,f.client.keyScope(f.config));
f.sqlite.prepare('UPDATE household_crypto_vaults SET public_key_json=?,iv=?,ciphertext=? WHERE credential_id=?').run(JSON.stringify({...publicKey(reused.publicKeyJwk),householdKeySource:'tcloud-member'}),reused.payloadIv,reused.encryptedPayload,'fixture-credential');
f.sqlite.prepare('UPDATE household_crypto_grants SET wrapped_key=? WHERE credential_id=?').run(wrapped,'fixture-credential');
f.session.keyBundle=await keyBundle(f.env.DB,{householdId:'main',identityId:'primary-admin',credentialId:'fixture-credential',serviceLinkId:'fixture-link'});
const requests=[];let authentications=0,oldBootstrap=true,keySharingGate=null,keySharingFailure=false;
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost'),path=url.pathname;
    if(path.startsWith('/household/api/')){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString();
      requests.push({path,raw});
      if(path.endsWith('/api/keys/automatic')&&keySharingGate){await keySharingGate;if(keySharingFailure){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Synthetic expired session'}));return;}}
      if(path.endsWith('/api/session')&&oldBootstrap){oldBootstrap=false;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...f.session,sessionContext:'previous-device-session'}));return;}
      if(path.endsWith('/passkey/handoff')){authentications++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(f.session));return;}
      const headers={'X-Household-Session':req.headers['x-household-session']||''};
      if(path.endsWith('/api/session')&&!req.headers['x-household-session'])delete headers['X-Household-Session'];
      const result=await f.request(path.slice('/household'.length),raw?JSON.parse(raw):undefined,headers,req.method);
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;
    }
    if(path==='/security/passkey-client.js'){
      res.setHeader('Content-Type','text/javascript');
      res.end(`window.TRoomPasskeys={authenticate:async()=>({prfOutput:new Uint8Array(${JSON.stringify([...f.prf])}),handoff:{handoffToken:'fixture'}}),chooseLinkDialog:async links=>links[0]};`);return;
    }
    const file=path.startsWith('/household/')?new URL(path.slice('/household/'.length)||'index.html',new URL('../public/',import.meta.url))
      :path==='/cloud/crypto-vault.js'?new URL('../../cloud-worker/public/crypto-vault.js',import.meta.url)
      :path==='/assets/pwa-auto-update.js'?new URL('../../assets/pwa-auto-update.js',import.meta.url):null;
    if(!file){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',/\.(mjs|js)$/.test(file.pathname)?'text/javascript':file.pathname.endsWith('.css')?'text/css':file.pathname.endsWith('.png')?'image/png':file.pathname.endsWith('.webmanifest')?'application/manifest+json':'text/html');res.end(readFileSync(file));
  }catch{res.writeHead(500);res.end('synthetic fixture unavailable');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await engine.launch({headless:true}),context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
  const url=`http://127.0.0.1:${server.address().port}/household/`;
  await page.goto(url);await page.locator('#login').waitFor({state:'visible'});
  await page.locator('#login').click();await page.locator('#app-view').waitFor({state:'visible'});
  await page.getByText('Synthetic private browser entry',{exact:true}).waitFor({state:'visible'});
  assert.equal(authentications,1);
  const cacheIds=await page.evaluate(async()=>new Promise(resolve=>{const open=indexedDB.open('troom-household-keys',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('sessions'),get=tx.objectStore('sessions').getAllKeys();get.onsuccess=()=>resolve(get.result);tx.oncomplete=()=>db.close();};}));
  assert.ok(cacheIds.length===1&&cacheIds[0].startsWith(f.session.sessionContext+'|'),'new login must replace the previous session key context');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM household_datasets WHERE household_id='main' AND crypto_version=0").get().n,0);
  const reloadMark=requests.length;let releaseSharing;
  keySharingGate=new Promise(resolve=>{releaseSharing=resolve;});
  const sharingRequest=page.waitForRequest(r=>r.url().endsWith('/api/keys/automatic')).catch(()=>null);
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});assert.equal(authentications,1,'reload must use only session-bound, non-extractable device keys');
  await page.getByText('Synthetic private browser entry',{exact:true}).waitFor({state:'visible'});
  assert.ok(await sharingRequest,'post-paint sharing request must run');
  assert.deepEqual(requests.slice(reloadMark, reloadMark+2).map(r=>r.path),['/household/api/session','/household/api/data']);
  assert.equal(requests.slice(reloadMark).some(r=>r.path.endsWith('/encryption/migration')),false);
  releaseSharing();keySharingGate=null;
  await page.waitForLoadState('networkidle');
  const repeatedReload=requests.length;
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});
  assert.equal(authentications,1,'repeated cached opens must keep working without another passkey prompt');
  assert.deepEqual(requests.slice(repeatedReload,repeatedReload+2).map(r=>r.path),['/household/api/session','/household/api/data']);
  await page.waitForLoadState('networkidle');
  // A failed background authority check must still lock the displayed ledger.
  keySharingFailure=true;keySharingGate=new Promise(resolve=>{releaseSharing=resolve;});
  const expiredSharing=page.waitForRequest(r=>r.url().endsWith('/api/keys/automatic')).catch(()=>null);
  await page.locator('#refresh').click();assert.ok(await expiredSharing,'forced post-paint expiry check must run');
  assert.equal(await page.locator('#app-view').isVisible(),true,'held optional sharing must not hide the displayed ledger');
  releaseSharing();await page.locator('#login-view').waitFor({state:'visible'});
  assert.doesNotMatch(await page.locator('body').innerText(),/Synthetic private|Synthetic new encrypted/);
  keySharingGate=null;keySharingFailure=false;
  await page.locator('#login').click();await page.locator('#app-view').waitFor({state:'visible'});
  await page.locator('#add-entry').click();await page.locator('#entry-form [name=description]').fill('Synthetic new encrypted entry');
  await page.locator('#entry-form [name=amount]').fill('2468');await page.locator('#entry-form [type=submit]').click();
  await page.locator('#entry-dialog').waitFor({state:'hidden'});await page.getByText('Synthetic new encrypted entry',{exact:true}).waitFor({state:'visible'});
  const writes=requests.filter(r=>/\/(mutate|restore)$/.test(r.path));assert.ok(writes.length>0);assert.doesNotMatch(JSON.stringify(writes.map(r=>JSON.parse(r.raw))),/Synthetic|"(?:amount|description|categoryId|prfOutput)"\s*:/);
  await page.locator('[data-view=settings]').click();
  const backupEvent=page.waitForEvent('download');await page.locator('#export-backup').click();
  const file=await backupEvent,backup=JSON.parse(readFileSync(await file.path(),'utf8'));
  assert.equal(backup.version,3);assert.doesNotMatch(JSON.stringify(backup),/Synthetic|"(?:amount|description|categoryId)"\s*:/);
  await page.locator('#restore-file').setInputFiles({name:'encrypted-household.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.waitForFunction(()=>!document.getElementById('restore').disabled);await page.locator('#restore').click();await page.locator('#confirm-ok').click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});
  assert.equal((await f.api('/data')).encrypted,true);
  await page.locator('#logout').click();await page.locator('#login-view').waitFor({state:'visible'});
  assert.doesNotMatch(await page.locator('body').innerText(),/Synthetic private|Synthetic new encrypted/);
  const keyCount=await page.evaluate(async()=>new Promise(resolve=>{const open=indexedDB.open('troom-household-keys',1);open.onsuccess=()=>{const db=open.result,tx=db.transaction('sessions');const get=tx.objectStore('sessions').getAll();get.onsuccess=()=>resolve(get.result.length);tx.oncomplete=()=>db.close();};}));
  assert.equal(keyCount,0);assert.deepEqual(errors,[]);
  console.log('Encrypted Household browser: migration, two-request cached startup with held sharing, deferred revocation, input, export/restore and logout passed (synthetic PRF).');
}catch(error){
  console.error(JSON.stringify({loginError:await page.locator('#login-error').textContent().catch(()=>''),bootMessage:await page.locator('#boot-message').textContent().catch(()=>''),pageErrors:errors,recentRequests:requests.slice(-12).map(r=>r.path)}));
  throw error;
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));f.close();}
