import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, RevisionConflict } from '../public/health-api.mjs';
import { createState } from '../public/health-state.mjs';
function setup(t,response) {
  const state=createState(); state.auth.session='fixture-session';
  const invalidations=[];t.mock.method(globalThis,'fetch',async()=>response);
  return {state,invalidations,api:createApi(state,message=>invalidations.push(message))};
}
test('HTML, text, empty and malformed JSON infrastructure errors use a safe message and preserve the session', async t=>{
  for(const [status,body,type] of [[502,'<html>proxy failure</html>','text/html'],[503,'unavailable','text/plain'],[500,'','application/json'],[502,'{','application/json'],[500,'null','application/json'],[429,'','text/plain']]){
    const f=setup(t,new Response(body,{status,headers:{'Content-Type':type}}));
    await assert.rejects(f.api('/records'), e=>!(e instanceof SyntaxError) && /一時的|集中/.test(e.message) && !/proxy|unavailable|Unexpected/.test(e.message));
    assert.deepEqual(f.invalidations,[]);assert.equal(f.state.auth.session,'fixture-session');
    t.mock.restoreAll();
  }
});
test('non-JSON authorization failures still invalidate the session', async t=>{
  for(const status of [401,403]){
    const f=setup(t,new Response('blocked',{status,headers:{'Content-Type':'text/html'}}));
    await assert.rejects(f.api('/records'),/パスキー/);assert.equal(f.invalidations.length,1);t.mock.restoreAll();
  }
});
test('revision conflict remains distinct from session switch, and valid JSON survives charset parameters', async t=>{
  let f=setup(t,Response.json({error:'draft retained',code:'revision_conflict'},{status:409}));
  await assert.rejects(f.api('/records'),RevisionConflict);assert.deepEqual(f.invalidations,[]);t.mock.restoreAll();
  f=setup(t,Response.json({error:'session changed',code:'session_changed'},{status:409}));
  await assert.rejects(f.api('/records'),/session changed/);assert.equal(f.invalidations.length,1);t.mock.restoreAll();
  f=setup(t,new Response('{"records":[]}',{headers:{'Content-Type':'application/json; charset=utf-8'}}));
  assert.deepEqual(await f.api('/records'),{records:[]});
});
test('malformed success responses cannot be mistaken for a saved record', async t=>{
  const f=setup(t,new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}));
  await assert.rejects(f.api('/records'),/応答/);assert.deepEqual(f.invalidations,[]);
});
test('an invalidated generation cannot process a late non-JSON authorization response', async t=>{
  const f=setup(t,new Response('expired',{status:401}));const generation=f.state.auth.generation;
  t.mock.method(globalThis,'fetch',async()=>{f.state.erase();return new Response('expired',{status:401});});
  await assert.rejects(f.api('/records',{},generation),/画面を離れた/);assert.deepEqual(f.invalidations,[]);
});

test('200 JSON with invalid record/write/logout schemas is rejected without invalidating the session',async t=>{
  const row={id:'a'.repeat(43),iv:'a'.repeat(16),ciphertext:'a'.repeat(24),revision:1};
  const cases=[['/records','GET',[{}, {records:null},{records:{}},{records:[null]}, {records:[{...row,revision:'1'}]}]],
    ...['PUT','DELETE'].map(method=>['/records/'+row.id,method,[{}, {ok:false,revision:1},{revision:1},...[0,-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1].map(revision=>({ok:true,revision}))]]),
    ['/logout','POST',[{}, {ok:false}]]];
  for(const [path,method,values] of cases)for(const value of values){
    const f=setup(t,Response.json(value));await assert.rejects(f.api(path,{method}),/応答/);
    assert.deepEqual(f.invalidations,[]);assert.equal(f.state.auth.session,'fixture-session');t.mock.restoreAll();
  }
  for(const [path,method,value] of [['/records','GET',{records:[row]}],['/records/'+row.id,'PUT',{ok:true,revision:1}],['/records/'+row.id,'DELETE',{ok:true,revision:2}],['/logout','POST',{ok:true}]]){
    const f=setup(t,Response.json(value));assert.deepEqual(await f.api(path,{method}),value);t.mock.restoreAll();
  }
});

test('handoff requires a usable session, expiry, account context and encrypted key bundle',async t=>{
  const bundle={accountId:'fixture-account',wrappedKey:'a'.repeat(512),vault:{iv:'a'.repeat(16),ciphertext:'a'.repeat(2400),publicKey:{kty:'RSA',n:'a'.repeat(512),e:'AQAB'}}};
  const valid={sessionId:'fixture-session-123',expiresAt:Math.floor(Date.now()/1000)+60,keyBundle:bundle};
  const malformed=[{}, {...valid,sessionId:''},{...valid,expiresAt:0},{...valid,expiresAt:valid.expiresAt+0.5},{...valid,keyBundle:null},
    {...valid,keyBundle:{...bundle,accountId:null}},{...valid,keyBundle:{...bundle,wrappedKey:''}},
    {...valid,keyBundle:{...bundle,vault:{...bundle.vault,iv:'bad'}}},{...valid,keyBundle:{...bundle,vault:{...bundle.vault,publicKey:{kty:'EC'}}}}];
  for(const value of malformed){const f=setup(t,Response.json(value));await assert.rejects(f.api('/passkey/handoff',{method:'POST'}),/応答/);t.mock.restoreAll();}
  const f=setup(t,Response.json(valid));assert.deepEqual(await f.api('/passkey/handoff',{method:'POST'}),valid);
});
