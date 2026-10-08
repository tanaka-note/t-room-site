import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixture, fixturePassword, securityDatabase } from './password-login-audit-fixture.mjs';
const {chromium}=createRequire(new URL('../../diary-worker/package.json',import.meta.url))('playwright');
const read=path=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
const fixtures={};
for(const service of ['billing']) {
  const f=fixture(service); f.security=await securityDatabase(f,service);
  if(service!=='cloud') f.disablePassword();fixtures[service]=f;
}
function script(service) {
  const source=read(`${service}-worker/public/${service}.js`);
  const name=service==='diary'?'handleLogin':'login';
  const start=source.indexOf(`async function ${name}(event) {`);
  const end=source.indexOf(`async function ${service==='diary'?'handlePasskeyLogin':'loginWithPasskey'}()`,start);
  const apiStart=source.indexOf('async function api(path, options = {}) {');
  const apiEnd=source.indexOf(service==='cloud'?'function handleError':service==='diary'?'function createTagGroup':'function basePath',apiStart);
  return `const API='/${service}/api',BASE_PATH='/${service}',state={};
    const $=s=>document.querySelector(s),form=$('#login-form');
    const el=Object.fromEntries([...document.querySelectorAll('[id]')].map(n=>[n.id,n]));
    const elements={loginForm:form,loginId:$('#login-id'),password:$('#login-password')||$('#password'),loginMessage:$('#login-message')||$('#login-error')};
    const TCloudSession={fetch:fetch.bind(globalThis),beginSelection(){}};
    function showLoginError(message){$('#login-error').textContent=message;}
    function setBusy(button,busy){button.disabled=busy;}
    const updateRememberedLogin=async()=>{},enterApp=async()=>{},enterDiary=async()=>{},saveLoginPreference=async()=>{},showInitialPasswordSetup=async()=>{};
    function canonicalLoginId(value){return value.trim().toLowerCase();}
    function basePath(){return '/${service}';}
    ${source.slice(apiStart,apiEnd)}
    ${source.slice(start,end)}
    state.passwordLoginAudit=TRoomPasswordLoginAudit.create({service:'${service}',apiBase:API,form,loginIdInput:elements.loginId});
    form.addEventListener('submit',${name});
    document.querySelector('#boot-view')?.setAttribute('hidden','');
    document.querySelector('#login-view').hidden=false;
    globalThis.fixtureReady=true;`;
}
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'),service=url.pathname.split('/')[1];
    if (url.pathname === '/cloud/vendor/argon2.umd.min.js' || url.pathname === '/cloud/crypto-vault.js') {
      res.setHeader('Content-Type','text/javascript');res.end(read(url.pathname.slice(1)));return;
    }
    if(!fixtures[service]) {res.writeHead(404).end();return;}
    const file=url.pathname.split('/').slice(2).join('/');
    if(file.startsWith('api/')) {
      if(file==='api/auth-mode') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mode:'legacy',credentialSalt:''}));return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const result=await fixtures[service].request(file.slice(4),Buffer.concat(chunks).toString(),req.headers['x-login-correlation-id']?{'X-Login-Correlation-ID':req.headers['x-login-correlation-id']}:{});
      res.writeHead(result.status,{'Content-Type':'application/json'});res.end(result.body?JSON.stringify(result.body):'');return;
    }
    if(file==='fixture.js') {res.setHeader('Content-Type','text/javascript');res.end(script(service));return;}
    if(!file) {
      let html=read(`${service}-worker/public/index.html`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
      html=html.replace('</body>',`<script src="/${service}/password-login-audit.js"></script><script src="/cloud/vendor/argon2.umd.min.js"></script><script src="/cloud/crypto-vault.js"></script><script src="/${service}/fixture.js"></script></body>`);
      res.setHeader('Content-Type','text/html');res.end(html);return;
    }
    if(file.includes('..')) {res.writeHead(404).end();return;}
    const data=read(`${service}-worker/public/${file}`);
    if(file==='password-login-audit.js') {
      const response=await fixtures[service].asset(file,data);
      res.writeHead(response.status,{'Content-Type':response.headers.get('Content-Type')});res.end(await response.text());return;
    }
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(data);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
try {
  for(const service of ['billing']) {
    const page=await browser.newPage(),f=fixtures[service];
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/${service}/`);await page.waitForFunction(()=>globalThis.fixtureReady);
    const pw=page.locator(service==='diary'?'#password':'#login-password');
    // Real native required validation prevents the production submit handler.
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#login-id').validity.valueMissing);
    await assertEventually(()=>f.stored.some(e=>e.details.stage==='form_validation'));
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${service}_login_attempts`).get().n,0);
    f.stored.length=0;
    await page.locator('#login-id').fill(f.loginId);await pw.fill(service==='cloud'?'short':fixturePassword);
    await page.locator('#login-form button[type=submit]').click();
    await assertEventually(()=>f.stored.some(e=>e.eventType===(service==='cloud'?'password_login_client_failure':'password_login_failure')));
    const event=f.stored.at(-1);
    assert.equal(event.details.reason,service==='cloud'?'password_length_invalid':'password_auth_disabled');
    if(service==='cloud') {
      assert.equal(event.details.stage,'credential_derivation');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cloud_login_attempts').get().n,0);
      f.stored.length=0;
      await pw.fill('incorrect-long-fixture');await page.locator('#login-form button[type=submit]').click();
      await assertEventually(()=>f.stored.some(e=>e.eventType==='password_login_failure'));
    }
    const submit=f.stored.find(e=>e.eventType==='password_login_submit'),failure=f.stored.at(-1);
    assert.equal(submit.details.requestCorrelationId,failure.details.requestCorrelationId);
    assert.ok(f.security.db.prepare('SELECT COUNT(*) AS n FROM security_audit_events').get().n>0);
    assert.deepEqual(errors,[]);
    assert.doesNotMatch(JSON.stringify(f.stored),/short|incorrect-long-fixture|local-audit-fixture-password|authProof|accountKey/);
    await page.close();
    console.log(`${service}: Chromium native validation and correlated password failure reached Security SQLite`);
  }
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
  for(const f of Object.values(fixtures)) {f.security.close();f.close();}
}
async function assertEventually(check) {
  const until=Date.now()+10000;
  while(!check()&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(check(),'Expected audit did not arrive');
}
