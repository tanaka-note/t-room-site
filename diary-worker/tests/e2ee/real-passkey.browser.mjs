// Actual WebAuthn PRF and SimpleWebAuthn verification with a local virtual
// authenticator. All identities/recovery keys are synthetic, no production IO.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
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
security.env={...f.centralEnv,SESSION_SECRET:randomBytes(32).toString('base64url'),PASSKEY_ENABLED:'true',RP_ID:'localhost'};security.ctx=f.ctx;
f.env.SECURITY=security;
const root=fileURLToPath(new URL('../../public/',import.meta.url));let origin,failConfiguration=true;
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if(url.pathname.includes('/api/')) {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);wire.push({path:url.pathname,body:body.toString()});
      if(url.pathname==='/diary/api/encryption/manage/config'&&failConfiguration){failConfiguration=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Synthetic connection loss before configuration persistence"}');return;}
      const request=new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )});
      const reply=url.pathname.startsWith('/security/')?await security.fetch(request):await f.worker.fetch(request,f.env,f.ctx);
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
  // Other system-fixture credentials are deliberately non-WebAuthn placeholders.
  // Only this actually registered credential participates in the real ceremony.
  f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id<>?").run(credential.id);
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
  await login(0);
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('tlain-diary-authority-public-v1-automatic-pending')),null);
  assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'legacy');
  await page.click('#logout-button');await page.locator('#passkey-login').waitFor({state:'visible'});
  f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='encrypted',ever_encrypted=1,generation=1");
  await login(1);
  assert.equal(await page.getByLabel('日記の信頼設定ファイル').count(),0);
  const before=wire.filter(row=>row.path==='/security/api/auth/verify').length;
  await page.reload();await page.locator('#app-view').waitFor({state:'visible'});
  assert.equal(wire.filter(row=>row.path==='/security/api/auth/verify').length,before);
  assert.equal(wire.some(row=>row.body?.includes('prfOutput')),false);assert.deepEqual(errors,[]);
  console.log('Actual WebAuthn PRF with virtual authenticator: existing central recovery envelope, normal owner initialization, shared passkey ordinary account, sealed trust and session reload passed; no JSON or physical-user credentials.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await f.close();}
