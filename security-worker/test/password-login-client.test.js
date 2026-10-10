import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
export function loginHandler(service) {
  const source=read(`${service}-worker/public/${service}.js`);
  const name=service==='diary'?'handleLogin':'login';
  const start=source.indexOf(`async function ${name}(event) {`);
  const end=source.indexOf(`async function ${service==='cloud'?'loginWithPasskey':service==='diary'?'handlePasskeyLogin':'loginWithPasskey'}()`,start);
  return source.slice(start,end).trim();
}
const helper=read('cloud-worker/public/password-login-audit.js');
function fixture(service, {password='short', loginId='user@example.test', apiFailure=null, deriveFailure=false, telemetryOffline=false}={}) {
  const sent=[], calls=[], warnings=[], storage=new Map(), listeners=new Map();
  const submit={disabled:false,textContent:'Login',setAttribute(){},removeAttribute(){}};
  const form={querySelector:()=>submit,addEventListener:(name,callback)=>listeners.set(name,callback)};
  const id={value:loginId}, pw={value:password,select(){}};
  const el={'login-form':form,'login-id':id,'login-password':pw,'login-submit':submit,'login-error':{textContent:''}};
  const elements={loginForm:form,loginId:id,password:pw,loginMessage:{textContent:''}};
  const context={crypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa,AbortController,URL,Date,JSON,setTimeout,clearTimeout,queueMicrotask,
    navigator:{},matchMedia:()=>({matches:false}),addEventListener(){},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    document:{querySelector:selector=>selector.includes('meta[')?{content:`${service}-0123456789ab`}:el[selector.slice(1)]},
    console:{warn:(...args)=>warnings.push(args)},el,elements,state:{},setBusy(){},showLoginError(){},
    $:selector=>selector.includes('button')?submit:el[selector.slice(1)],
    fetch:async(_url,options)=>{sent.push(JSON.parse(options.body));if(telemetryOffline)throw new Error('local-network-error');return {ok:true};},
    api:async(path,options)=>{calls.push({path,options});if(apiFailure?.path===path)throw Object.assign(new Error('fixture-ui-error'),apiFailure.error);return path==='/auth-mode'?{mode:'legacy',credentialSalt:''}:{authenticated:true};},
    updateRememberedLogin:async()=>{},enterApp:async()=>{},enterDiary:async()=>{},saveLoginPreference:async()=>{},
    showInitialPasswordSetup:async()=>{},canonicalLoginId:v=>v.trim().toLowerCase(),
    hashwasm:{argon2id:async()=>{if(deriveFailure)throw new Error('fixture-derive-error');return new Uint8Array(32);}}
  };
  context.window=context;
  vm.createContext(context);
  vm.runInContext(read('cloud-worker/public/crypto-vault.js'),context);
  vm.runInContext(helper,context);
  context.state.passwordLoginAudit=context.TRoomPasswordLoginAudit.create({service,apiBase:`/${service}/api`,form,loginIdInput:id});
  vm.runInContext(`${loginHandler(service)};globalThis.runLogin=${service==='diary'?'handleLogin':'login'};`,context);
  return {sent,calls,context,storage,listeners,warnings,async login(){await context.runLogin({preventDefault(){},submitter:submit});}};
}

test('helper copies and HTML execution order match each service',()=>{
  for(const service of ['billing']) {
    assert.equal(read(`${service}-worker/public/password-login-audit.js`),helper);
    const html=read(`${service}-worker/public/index.html`);
    const scripts=[...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match=>match[1]);
    assert.ok(scripts.findIndex(src=>src.includes('password-login-audit.js')) < scripts.findIndex(src=>src.includes(`${service}.js`)));
    assert.match(html,/Passkeyへ移行済みの場合/);
  }
});
test('Cloud retires its password form while Security Center retains its recovery form',()=>{
  assert.doesNotMatch(read('cloud-worker/public/index.html'), /id="login-form"|id="login-password"|remember-login|password-login-audit\.js/);
  assert.doesNotMatch(read('cloud-worker/public/cloud.js'), /async function login\(event\)|PasswordCredential/);
  assert.match(read('security-worker/public/index.html'), /id="bootstrap-form"/);
  assert.match(read('security-worker/public/security.js'), /TRoomPasskeys\.bootstrap/);
});
for(const service of ['billing']) {
  test(`${service}: login network failure is correlated, server 401 is not double-counted`,async()=>{
    const network=fixture(service,{password:'long-fixture',apiFailure:{path:'/login',error:{}}});await network.login();
    assert.equal(network.sent.at(-1).stage,'login_request');assert.equal(network.sent.at(-1).reason,'network_error');
    assert.equal(network.calls.at(-1).options.headers['X-Login-Correlation-ID'],network.sent[0].requestCorrelationId);
    const rejected=fixture(service,{password:'long-fixture',apiFailure:{path:'/login',error:{status:401}}});await rejected.login();
    assert.equal(rejected.sent.length,1);assert.equal(rejected.sent[0].eventType,'password_login_submit');
  });
  test(`${service}: native validation reports and offline buffering contain metadata only`,async()=>{
    const f=fixture(service,{telemetryOffline:true});
    f.listeners.get('invalid')({target:f.context.elements.loginId});
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(f.sent.at(-1).stage,'form_validation');
    assert.equal(f.sent.at(-1).reason,'login_id_invalid');
    assert.doesNotMatch(JSON.stringify([...f.storage.values()]),/short|user@example\.test|authProof|cookie/);
    assert.equal(f.calls.length,0);
  });
}
