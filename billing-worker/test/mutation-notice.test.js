import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../public/billing.js',import.meta.url),'utf8');
const api=source.slice(source.indexOf('  async function api('),source.indexOf('  function basePath('));
for(const resource of ['entries','settlements'])for(const method of ['POST','PUT','DELETE'])test(`${resource} ${method}: uncertain 401 is shown on login, never retried`,async()=>{
  let calls=0,logins=0;
  const note={textContent:'',hidden:true};
  const state={summary:{account:{id:'fixture'},month:'2026-09'}};
  const context=vm.createContext({state,el:{'login-operation-note':note,'document-filter':{value:'payment_notice'},'month-input':{value:'2026-09'}},
    uncertainOperationMessage:'ログイン状態が終了しました。保存されている可能性があります。同じ操作を繰り返さないでください。',
    basePath:()=>'/billing',showLogin:()=>{logins++;},fetch:async()=>{calls++;return {status:401,ok:false,json:async()=>({error:'ログインが必要です。'})};}});
  vm.runInContext(api,context);
  const options={method,body:method==='DELETE'?{}:{accountId:'fixture',entryDate:'2026-10-24',documentType:'invoice'}};
  await assert.rejects(context.api(`/${resource}${method==='POST'?'':'/1'}`,options),e=>e.status===401&&/保存されている可能性.*繰り返さない/.test(e.message));
  assert.equal(calls,1);assert.equal(logins,1);assert.equal(note.hidden,false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.uncertainOperationView)),{accountId:'fixture',month:method==='DELETE'?'2026-09':'2026-10',documentType:method==='DELETE'?'payment_notice':'invoice'});
});

for(const [path,method,logins]of [['/summary','GET',1],['/logout','POST',1],['/passkey/handoff','POST',0]])test(`${path}: unrelated 401 does not claim a financial write`,async()=>{
  let count=0;
  const note={textContent:'',hidden:true};
  const context=vm.createContext({state:{},el:{'login-operation-note':note},basePath:()=>'/billing',showLogin:()=>count++,fetch:async()=>({status:401,ok:false,json:async()=>({error:'Login required'})})});
  vm.runInContext(api,context);
  await assert.rejects(context.api(path,{method}),e=>e.status===401&&e.message==='Login required');
  assert.equal(count,logins);assert.equal(note.hidden,true);
});
