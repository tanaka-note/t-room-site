// Actual WebAuthn PRF and SimpleWebAuthn verification with a local virtual
// authenticator. All identities/recovery keys are synthetic, no production IO.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {Bucket} from '../../../backup-worker/test/fixtures.mjs';
import {exportFetcher,exportEnv} from '../../../backup-worker/test/export-fixtures.mjs';
import {saveExport} from '../../../backup-worker/src/export-backup.js';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
const require=createRequire(new URL('../../../security-worker/package.json',import.meta.url));
const {verifyRegistrationResponse}=require('@simplewebauthn/server');
const {default:SecurityWorker}=await import('../../../security-worker/src/index.js');
const f=await systemFixture({phase:'legacy',recoveryExtractable:true}),security=new SecurityWorker(),wire=[],errors=[];
const bucket=new Bucket();f.env.BACKUP=bucket;
f.env.ASSETS={fetch:async()=>new Response('<meta name="troom-app-build" content="diary-0123456789ab">')};
f.env.D1_BACKUPS={create:async value=>{
  const mock=exportFetcher(f.db.sqlite,'diary',{migration:'diary-e2ee-v1'});
  await saveExport({...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central},'diary',Date.now(),{checkpoint:value.params.checkpoint,fetcher:mock.fetcher,sleep:async()=>{}});
  return {id:value.id};
}};
f.db.sqlite.exec("INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status,revision) VALUES(10,'2026-11-15','AUTOMATIC_PRIVATE_TITLE','AUTOMATIC_PRIVATE_BODY','wife-admin','Synthetic author','tanaka-household','published',1);INSERT INTO diary_favorites(account_id,entry_id) VALUES('wife-admin',10);INSERT INTO investment_history(recorded_at,total,cash) VALUES('2026-01-01',123456789,123456789)");
f.db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
security.env={...f.centralEnv,SESSION_SECRET:randomBytes(32).toString('base64url'),PASSKEY_ENABLED:'true',RP_ID:'localhost'};security.ctx=f.ctx;
f.env.SECURITY=security;
const root=resolve(fileURLToPath(new URL('../../public/',import.meta.url)));let origin,failConfiguration=true,failImport=true,failCutover=true;
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.includes('/api/')) {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);wire.push({path:url.pathname,body:body.toString()});
      if(url.pathname==='/diary/api/encryption/manage/config'&&failConfiguration){failConfiguration=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Synthetic connection loss before configuration persistence"}');return;}
      if(url.pathname==='/diary/api/encryption/manage/control'&&JSON.parse(body.toString()).next==='encrypted'&&failCutover){failCutover=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Synthetic lost cutover request"}');return;}
      const request=new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )});
      const reply=url.pathname.startsWith('/security/')?await security.fetch(request):await f.worker.fetch(request,f.env,f.ctx);
      if(url.pathname==='/diary/api/encryption/manage/migration/import'&&reply.ok&&failImport){failImport=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Synthetic lost import response"}');return;}
      if(reply.status>=400)wire.push({path:url.pathname,status:reply.status,error:(await reply.clone().json().catch(()=>({}))).error});
      const headers=Object.fromEntries(reply.headers);delete headers['set-cookie'];if(reply.headers.getSetCookie().length)headers['Set-Cookie']=reply.headers.getSetCookie();
      res.writeHead(reply.status,headers);res.end(Buffer.from(await reply.arrayBuffer()));return;
    }
    if(url.pathname==='/assets/pwa-auto-update.js'){res.setHeader('Content-Type','text/javascript');res.end('/* No production updates. */');return;}
    let file;
    if(url.pathname==='/security/passkey-client.js')file=fileURLToPath(new URL('../../../security-worker/public/passkey-client.js',import.meta.url));
    else if(url.pathname==='/cloud/crypto-vault.js')file=fileURLToPath(new URL('../../../cloud-worker/public/crypto-vault.js',import.meta.url));
    else {file=resolve(root,url.pathname==='/diary/'?'index.html':url.pathname.slice('/diary/'.length));if(!url.pathname.startsWith('/diary/')||!file.startsWith(root.replace(/\/$/,'')+sep)){res.writeHead(404);res.end();return;}}
    res.setHeader('Content-Type',['.js','.mjs'].includes(extname(file))?'text/javascript':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(file));
  }catch(error){errors.push(error.name);res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://localhost:'+server.address().port;
security.env.EXPECTED_ORIGIN=origin;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext(),page=await context.newPage(),cdp=await context.newCDPSession(page);
  page.on('pageerror',error=>errors.push(error.message));
  await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  await page.goto(origin+'/diary/');await page.locator('#passkey-login').waitFor({state:'visible'});
  await page.addScriptTag({url:origin+'/cloud/crypto-vault.js'});
  const challenge=randomBytes(32).toString('base64url'),salt=randomBytes(32).toString('base64url');
  const raw=new Uint8Array(await crypto.subtle.exportKey('pkcs8',f.recovery.privateKey));
  let registration;
  try{registration=await page.evaluate(async({challenge,salt,recovery})=>{
    const decode=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
    const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const credential=await navigator.credentials.create({publicKey:{challenge:decode(challenge),rp:{id:'localhost',name:'Synthetic local fixture'},user:{id:crypto.getRandomValues(new Uint8Array(32)),name:'synthetic-owner',displayName:'Synthetic owner'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},extensions:{prf:{eval:{first:decode(salt)}}}}});
    const response=credential.toJSON();response.clientExtensionResults={prf:{enabled:true}};
    const assertion=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:'localhost',allowCredentials:[{type:'public-key',id:credential.rawId}],userVerification:'required',extensions:{prf:{eval:{first:decode(salt)}}}}});
    const prf=new Uint8Array(assertion.getClientExtensionResults().prf.results.first),privateBytes=decode(recovery);
    try {
      const accountKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']),iv=crypto.getRandomValues(new Uint8Array(12));
      const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('T-ROOM Cloud Storage admin private key v1')},accountKey,privateBytes);
      return {response,envelope:await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey,{adminPrivateCipher:encode(cipher),adminPrivateIv:encode(iv)},prf)};
    }finally{prf.fill(0);privateBytes.fill(0);}
  },{challenge,salt,recovery:Buffer.from(raw).toString('base64url')});}finally{raw.fill(0);}
  const verified=await verifyRegistrationResponse({response:registration.response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:'localhost',requireUserVerification:true});assert.equal(verified.verified,true);
  const credential=verified.registrationInfo.credential,old=f.users['main-admin'].credentialId;
  f.central.sqlite.exec('DELETE FROM security_diary_key_grants;DELETE FROM security_diary_key_config;');
  f.central.sqlite.prepare('DELETE FROM security_diary_key_vaults WHERE credential_id=?').run(old);
  f.central.sqlite.prepare('UPDATE security_credentials SET credential_id=?,public_key=?,prf_salt=?,counter=? WHERE credential_id=?').run(credential.id,Buffer.from(credential.publicKey).toString('base64url'),salt,credential.counter,old);
  // Other approved people remain active but have never prepared Diary keys.
  // Valid option identifiers let the real authenticator select only its own key.
  for(const row of f.central.sqlite.prepare('SELECT credential_id FROM security_credentials WHERE credential_id<>?').all(credential.id)) {
    f.central.sqlite.prepare('UPDATE security_credentials SET credential_id=?,prf_salt=? WHERE credential_id=?').run(Buffer.from(row.credential_id).toString('base64url'),randomBytes(32).toString('base64url'),row.credential_id);
  }
  const owner=f.users['main-admin'];
  f.central.sqlite.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES('real-prf-envelope','primary-admin',?,?,'admin_private_prf',?,?)").run(credential.id,owner.serviceLinkId,registration.envelope.encryptedPayload,registration.envelope.payloadIv);
  const login=async index=>{
    await page.click('#passkey-login');
    try{await page.locator('.troom-passkey-account-option').nth(index).click({timeout:10000});await page.locator('#app-view').waitFor({state:'visible',timeout:20000});}catch(error){throw new Error('Real passkey failed: '+await page.locator('#login-message').textContent()+' '+JSON.stringify(wire.filter(row=>row.status)),{cause:error});}
  };
  await login(0);
  assert.equal(f.central.sqlite.prepare('SELECT COUNT(*) n FROM security_diary_key_config').get().n,0);
  assert.equal(await page.evaluate(()=>Boolean(localStorage.getItem('tlain-diary-authority-public-v1-automatic-pending'))),true);
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});
  await page.click('#passkey-login');await page.locator('.troom-passkey-account-option').nth(0).click();
  await page.waitForFunction(()=>document.querySelector('#login-message').textContent.includes('Synthetic lost import response'));
  assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
  assert.equal(await page.locator('#app-view').isVisible(),false);
  const savedCiphertext=f.db.sqlite.prepare('SELECT id,envelope FROM diary_e2ee_records ORDER BY id').all();
  // Reproduce the production timing: the independent editor's vault becomes
  // ready after the owner has frozen/imported the source. Owner resume must
  // grant it through normal login before completing the current migration.
  const {createVault:prepareVault}=await import('../../e2ee/crypto.mjs');
  const {diaryRecipientId:recipientFor,handleDiaryKeys:prepareKeys,diaryKeyBundle:readBundle}=await import('../../../security-worker/src/diary-keys.js');
  const independent=f.users['chiharu-admin'],independentCredential=Buffer.from(independent.credentialId).toString('base64url');
  const independentRecipient=await recipientFor(independentCredential,independent.serviceLinkId),independentPrf=new Uint8Array(independent.prf);
  const independentInput={identityId:independent.identityId,credentialId:independentCredential,serviceLinkId:independent.serviceLinkId,serviceAccountId:'chiharu-admin'};
  const independentVault=await prepareVault(independentPrf,independentRecipient);
  await prepareKeys('/api/diary/vault',new Request('https://fixture.test/security/api/diary/vault',{method:'POST',body:JSON.stringify({serviceLinkId:independent.serviceLinkId,vault:independentVault})}),security.env,{...independentInput,authenticatedAt:Date.now()/1000},f.helpers);
  assert.equal(await readBundle(security.env,independentInput),null);
  // Reproduce a different device's missing local migration plan. Only the
  // synthetic maintenance DB is removed; credentials and server rows remain.
  await page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('tlain-diary-maintenance-v1');request.onsuccess=resolve;request.onerror=()=>reject(request.error);}));
  await page.reload();await page.locator('#passkey-login').waitFor({state:'visible'});
  assert.match(await page.locator('#login-message').textContent(),/再開/);
  await page.click('#passkey-login');await page.locator('.troom-passkey-account-option').nth(0).click();
  await page.waitForFunction(()=>document.querySelector('#login-message').textContent.includes('Synthetic lost cutover request'));
  assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
  assert.equal(await page.evaluate(async()=>{const {openMaintenancePlans}=await import('/diary/crypto/e2ee/maintenance.mjs'),plans=await openMaintenancePlans();try{return Boolean(await plans.getProof());}finally{plans.close();}}),true);
  const checkpointRequests=wire.filter(row=>row.path.includes('/maintenance/checkpoint')||row.path.includes('/maintenance/backup')).length;
  await page.reload();await page.locator('#passkey-login').waitFor({state:'visible'});
  await login(0);
  assert.equal(wire.filter(row=>row.path.includes('/maintenance/checkpoint')||row.path.includes('/maintenance/backup')).length,checkpointRequests,'a verified cutover resumes with a fresh complete inventory check without another backup/SQLite drill');
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,2);
  assert.equal(await page.evaluate(()=>localStorage.getItem('tlain-diary-authority-public-v1-automatic-pending')),null);
  assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
  for(const row of savedCiphertext)assert.equal(f.db.sqlite.prepare('SELECT envelope FROM diary_e2ee_records WHERE id=?').get(row.id).envelope,row.envelope);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM diary_entries').get().n,0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM diary_favorites').get().n,0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM investment_history').get().n,0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM diary_e2ee_records').get().n,3);
  assert.ok(await readBundle(security.env,independentInput),'owner migration resume grants the already prepared independent editor without a Security UI or later owner login');
  independentPrf.fill(0);
  const {writerReadiness}=await (await import('../../../security-worker/src/diary-keys.js')).handleDiaryKeys('/api/diary/admin',new Request('https://fixture.test/security/api/diary/admin'),security.env,{identityId:'primary-admin',credentialId:credential.id,authenticatedAt:Date.now()/1000},f.helpers).then(response=>response.json());
  assert.equal(writerReadiness.ready,false,'the owner migrates before other people log in');
  assert.equal(JSON.stringify(wire).includes('AUTOMATIC_PRIVATE_BODY'),false);
  assert.equal(wire.some(row=>row.path.startsWith('/security/api/diary')),false);
  assert.equal(wire.filter(row=>row.path==='/security/api/auth/verify').length,4,'one passkey ceremony per normal login, including interrupted setup, import and final cutover');
  await page.click('#new-entry-button');await page.locator('#editor-dialog').waitFor({state:'visible'});
  await page.fill('#entry-title','FUTURE_PRIVATE_TITLE');await page.locator('#entry-content').fill('FUTURE_PRIVATE_BODY');
  await page.click('#save-entry-button');await page.locator('#editor-dialog').waitFor({state:'hidden'});
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM diary_entries').get().n,0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM diary_e2ee_records').get().n,4);
  assert.equal(JSON.stringify(wire).includes('FUTURE_PRIVATE_BODY'),false);
  // An approved person who logs in later prepares their own immutable vault.
  // Only the owner's next normal login grants their existing personal scope.
  const {createVault,open}=await import('../../e2ee/crypto.mjs');
  const {handleDiaryKeys,diaryRecipientId,diaryKeyBundle}=await import('../../../security-worker/src/diary-keys.js');
  const editor=f.users['wife-admin'],editorCredential=Buffer.from(editor.credentialId).toString('base64url');
  const editorRecipient=await diaryRecipientId(editorCredential,editor.serviceLinkId),editorPrf=crypto.getRandomValues(new Uint8Array(32));
  const editorInput={identityId:editor.identityId,credentialId:editorCredential,serviceLinkId:editor.serviceLinkId,serviceAccountId:'wife-admin'};
  assert.equal(await diaryKeyBundle(security.env,editorInput),null);
  const editorVault=await createVault(editorPrf,editorRecipient);
  await handleDiaryKeys('/api/diary/vault',new Request('https://fixture.test/security/api/diary/vault',{method:'POST',body:JSON.stringify({serviceLinkId:editor.serviceLinkId,vault:editorVault})}),security.env,{...editorInput,authenticatedAt:Date.now()/1000},f.helpers);
  assert.equal(await diaryKeyBundle(security.env,editorInput),null,'preparation alone grants no access');
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});await login(0);
  const granted=await diaryKeyBundle(security.env,editorInput);assert.ok(granted);
  const {unlockSession}=await import('../../e2ee/session.mjs'),{parseRecord}=await import('../../e2ee/store.mjs'),{bindingOf}=await import('../../e2ee/record.mjs');
  const unlocked=await unlockSession({prf:editorPrf,profile:{...granted,actor:{accountId:'wife-admin',credentialId:editorRecipient},household:'tanaka-household',epochs:granted.directory.value.epochs},anchor:granted.anchor,minimumGeneration:granted.generation,checkSession:async()=>true});
  const favorite=parseRecord(f.db.sqlite.prepare("SELECT * FROM diary_e2ee_records WHERE state='preferences' AND author='wife-admin'").get());
  const personal=await open(unlocked.keys.get(favorite.scope),favorite.envelope,{...bindingOf(favorite),kind:'document'});
  assert.deepEqual(personal.entry.favorites,['10']);
  assert.equal(unlocked.keys.has('chiharu-household:published'),false,'late grants preserve household boundaries');
  unlocked.keys.clear();
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});
  await login(1);
  assert.equal(await page.getByLabel('日記の信頼設定ファイル').count(),0);
  const before=wire.filter(row=>row.path==='/security/api/auth/verify').length;
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});
  assert.equal(wire.filter(row=>row.path==='/security/api/auth/verify').length,before);
  assert.equal(wire.some(row=>row.body?.includes('prfOutput')),false);assert.deepEqual(errors,[]);
  console.log('Actual WebAuthn PRF with virtual authenticator: existing central recovery envelope, interrupted normal-login import and verified-cutover resume and automatic D1 cutover before other users enroll, encrypted future posts, late personal-scope grants, shared passkey ordinary account, sealed trust and session reload passed; no JSON or physical-user credentials.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}
