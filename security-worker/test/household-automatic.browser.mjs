// Real navigator.credentials PRF and SimpleWebAuthn verification, using only
// synthetic approved credentials in local SQLite. No authentication mock.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {verifyRegistrationResponse} from '@simplewebauthn/server';
import {automaticFixture} from './household-automatic-fixture.mjs';
const require=createRequire(new URL('../../diary-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const f=await automaticFixture(),requests=[],errors=[];
let origin;
const publicFile=(root,path)=>new URL(path||'index.html',new URL(root,import.meta.url));
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,origin),path=url.pathname;
    if(path.includes('/api/')){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      requests.push({path,body:body.toString()});
      const result=await (path.startsWith('/security/')?f.security:f.worker).fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body,duplex:'half'}:{})}));
      const headers=Object.fromEntries(result.headers);delete headers['set-cookie'];
      if(result.headers.getSetCookie().length)headers['Set-Cookie']=result.headers.getSetCookie();
      res.writeHead(result.status,headers);
      res.end(Buffer.from(await result.arrayBuffer()));return;
    }
    const file=path.startsWith('/household/')?publicFile('../../household-worker/public/',path.slice(11))
      :path==='/security/passkey-client.js'?publicFile('../public/','passkey-client.js')
      :path==='/cloud/crypto-vault.js'?publicFile('../../cloud-worker/public/','crypto-vault.js')
      :path.startsWith('/assets/')?publicFile('../../assets/',path.slice(8)):null;
    if(!file){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',/\.(js|mjs)$/.test(file.pathname)?'text/javascript':file.pathname.endsWith('.css')?'text/css':file.pathname.endsWith('.png')?'image/png':file.pathname.endsWith('.webmanifest')?'application/manifest+json':'text/html');
    res.end(readFileSync(file));
  }catch(error){errors.push(error.name);res.writeHead(500);res.end('synthetic fixture unavailable');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://localhost:${server.address().port}`;f.securityEnv.EXPECTED_ORIGIN=origin;
const browser=await chromium.launch({headless:true});
async function device(identityId,accountId,prepared=true){
  const context=await browser.newContext(),page=await context.newPage(),cdp=await context.newCDPSession(page);
  page.on('pageerror',e=>errors.push(e.message));
  await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  await page.goto(origin+'/household/');await page.locator('#login').waitFor({state:'visible'});
  const challenge=randomBytes(32).toString('base64url'),salt=randomBytes(32).toString('base64url');
  const registered=await page.evaluate(async({challenge,salt,identityId,prepared})=>{
    const bytes=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
    const credential=await navigator.credentials.create({publicKey:{challenge:bytes(challenge),rp:{id:'localhost',name:'Local synthetic fixture'},user:{id:crypto.getRandomValues(new Uint8Array(32)),name:identityId,displayName:identityId},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},extensions:{prf:{eval:{first:bytes(salt)}}}}});
    const response=credential.toJSON();response.clientExtensionResults={prf:{enabled:true}};
    if(!prepared)return {response,vault:null};
    const assertion=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:'localhost',allowCredentials:[{type:'public-key',id:credential.rawId}],userVerification:'required',extensions:{prf:{eval:{first:bytes(salt)}}}}});
    const secret=new Uint8Array(assertion.getClientExtensionResults().prf.results.first);
    try{const vault=await TRoomCrypto.createPasskeyClientVault(secret);return {response,vault:{publicKeyJwk:vault.publicKeyJwk,encryptedPayload:vault.encryptedPayload,payloadIv:vault.payloadIv}};}finally{secret.fill(0);}
  },{challenge,salt,identityId,prepared});
  const registration=await verifyRegistrationResponse({response:registered.response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:'localhost',requireUserVerification:true});
  assert.equal(registration.verified,true);
  const credential=registration.registrationInfo.credential;
  f.seed({identityId,accountId,credentialId:credential.id,publicKey:Buffer.from(credential.publicKey).toString('base64url'),counter:credential.counter,salt,vault:registered.vault});
  return {context,page,credentialId:credential.id};
}
async function login(device){
  await device.page.locator('#login').click();
  try{await device.page.locator('#app-view').waitFor({state:'visible',timeout:15000});}
  catch(error){throw new Error('Normal passkey login failed: '+await device.page.locator('#login-error').textContent(),{cause:error});}
}
try{
  const owner=await device('primary-admin','owner'),viewer=await device('fixture-viewer','viewer'),other=await device('fixture-other','chiharu-admin',false);
  await login(owner);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM household_datasets WHERE household_id='main' AND crypto_version=0").get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_grants').get().n,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,1);
  await owner.page.locator('#add-entry').click();await owner.page.locator('#entry-form [name=description]').fill('Synthetic real PRF encrypted expense');
  await owner.page.locator('#entry-form [name=amount]').fill('9876');await owner.page.locator('#entry-form [type=submit]').click();
  await owner.page.locator('#entry-dialog').waitFor({state:'hidden'});
  await login(viewer);await viewer.page.getByText('Synthetic real PRF encrypted expense',{exact:true}).waitFor();
  assert.equal(await viewer.page.locator('#add-entry').isVisible(),false);
  const auths=requests.filter(r=>r.path==='/security/api/auth/options').length;
  await owner.page.reload();await owner.page.locator('#app-view').waitFor({state:'visible'});
  await owner.page.getByText('Synthetic real PRF encrypted expense',{exact:true}).waitFor();
  assert.equal(requests.filter(r=>r.path==='/security/api/auth/options').length,auths,'reload uses session-bound non-extractable keys');
  await login(other);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM household_datasets WHERE crypto_version=0").get().n,0);
  assert.doesNotMatch(await other.page.locator('body').innerText(),/Synthetic real PRF encrypted expense/);
  const keyRequests=requests.filter(r=>/\/keys\/automatic/.test(r.path));assert.ok(keyRequests.some(r=>r.path.endsWith('/vault')));
  assert.doesNotMatch(JSON.stringify(requests.filter(r=>r.path.includes('/household/'))),/Synthetic real PRF encrypted expense|"amount":9876|prfOutput|privateKey|"d":/);
  for(const request of requests.filter(r=>r.path==='/security/api/auth/verify'))assert.equal(JSON.parse(request.body).response.clientExtensionResults?.prf?.results,undefined,'PRF output must stay in the browser');
  assert.equal(requests.some(r=>r.path.startsWith('/security/api/household/')),false,'normal login never enters manual Security setup/approval');
  assert.deepEqual(errors,[]);
  console.log('Real WebAuthn PRF: existing T-Cloud passkeys, automatic fallback vault, both household migrations, shared read-only access and cached reload passed.');
}finally{await browser.close();await new Promise(r=>server.close(r));f.close();}
