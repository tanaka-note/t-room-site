import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../public/health-state.mjs';
import { createApi } from '../public/health-api.mjs';
import { createSession } from '../public/health-session.mjs';
import { createClientVault, wrapMaster } from '../public/health-crypto.mjs';

let prf, master, bundle;
before(async () => {
  prf=crypto.getRandomValues(new Uint8Array(32));master=crypto.getRandomValues(new Uint8Array(32));
  const vault=await createClientVault(prf);
  bundle={accountId:'fixture-account',vault,wrappedKey:await wrapMaster(master,vault.publicKey,'fixture-account')};
});
after(()=>{prf?.fill(0);master?.fill(0);});

function setup(t, { cancel, noPrf, handoffStatus=200, badBundle=false, handoffResponse, cleanup, load }={}) {
  const state=createState(), calls=[], locks=[], authPrf=new Uint8Array(prf);
  let entered;const cleanupEntered=new Promise(resolve=>{entered=resolve;});
  const previous=globalThis.TRoomPasskeys;
  globalThis.TRoomPasskeys={authenticate:async()=>{
    if(cancel)throw cancel;
    return {prfOutput:noPrf?undefined:authPrf,handoff:{handoffToken:'synthetic-handoff'}};
  }};
  let session;
  const lock=message=>{locks.push(message);state.erase();session?.clearExpiry();};
  const api=createApi(state,lock);
  t.mock.method(globalThis,'fetch',async(path,options)=>{
    calls.push({path,options});
    if(path==='/health/api/passkey/handoff') {
      handoffResponse?.(state);
      return handoffStatus===200?Response.json({sessionId:'fixture-session-0123456789',expiresAt:Math.floor(Date.now()/1000)+60,
        keyBundle:badBundle?{...bundle,vault:null}:bundle}):Response.json({error:'handoff refused'},{status:handoffStatus});
    }
    assert.equal(path,'/health/api/logout');entered();
    assert.equal(options.headers['X-Health-Session'],'fixture-session-0123456789');
    assert.equal(options.credentials,'same-origin');assert.equal(options.body,'{}');
    return cleanup?cleanup(options,state):Response.json({ok:true});
  });
  session=createSession(state,api,async generation=>{
    state.data.records=[{note:'synthetic decrypted record'}];state.data.settings={cycleDays:28};state.data.revisions.set('fixture',1);
    await load?.(state,generation);
  },lock);
  t.after(()=>{session.clearExpiry();state.erase();authPrf.fill(0);if(previous===undefined)delete globalThis.TRoomPasskeys;else globalThis.TRoomPasskeys=previous;});
  return {state,session,calls,locks,authPrf,cleanupEntered,cleanupCalls:()=>calls.filter(call=>call.path==='/health/api/logout')};
}

function assertLocked(f) {
  assert.equal(f.state.auth.master,null);assert.equal(f.state.auth.session,null);assert.equal(f.state.auth.accountId,null);
  assert.deepEqual(f.state.data.records,[]);assert.deepEqual(f.state.data.settings,{});assert.equal(f.state.data.revisions.size,0);
}
function failDecrypt(t,algorithm,error) {
  const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'decrypt',async(...args)=>{if(args[0].name===algorithm)throw error;return decrypt(...args);});
}

test('successful handoff, real PRF unlock, master unwrap and load never call cleanup; normal logout stays unchanged',async t=>{
  const f=setup(t);await f.session.signIn(0);
  assert.equal(f.cleanupCalls().length,0);assert.equal(f.locks.length,0);
  assert.equal(f.state.auth.session,'fixture-session-0123456789');assert.equal(f.state.auth.accountId,'fixture-account');
  assert.ok(Buffer.from(f.state.auth.master).equals(Buffer.from(master)));assert.equal(f.state.data.records.length,1);assert.ok(f.authPrf.every(byte=>byte===0));
  await f.session.logout(0);assert.equal(f.cleanupCalls().length,1);assert.equal(f.cleanupCalls()[0].options.signal,undefined);
  assert.equal(f.locks.length,1);assertLocked(f);
});

test('passkey cancellation before handoff never calls Health or cleanup',async t=>{
  const original=new Error('パスキーをキャンセルしました');const f=setup(t,{cancel:original});
  await assert.rejects(f.session.signIn(0),error=>error===original);assert.equal(f.calls.length,0);assertLocked(f);
});
test('missing PRF before handoff locks without calling Health logout',async t=>{
  const f=setup(t,{noPrf:true});await assert.rejects(f.session.signIn(0),/暗号鍵/);
  assert.equal(f.calls.length,0);assert.equal(f.locks.length,1);assertLocked(f);
});
test('rejected handoff does not attempt to discard a session that was not issued',async t=>{
  const f=setup(t,{handoffStatus:401});await assert.rejects(f.session.signIn(0),/handoff refused/);
  assert.equal(f.cleanupCalls().length,0);assertLocked(f);assert.ok(f.authPrf.every(byte=>byte===0));
});

for(const [phase,algorithm] of [['private-key unlock','AES-GCM'],['master unwrap','RSA-OAEP']]) {
  test(`${phase} failure discards the issued session exactly once, after locking and erasing PRF`,async t=>{
    const original=new Error('暗号鍵を解除できませんでした');const f=setup(t,{cleanup:(_options,state)=>{
      assert.equal(state.auth.master,null);assert.equal(state.auth.session,null);assert.equal(state.auth.accountId,null);
      assert.ok(f.authPrf.every(byte=>byte===0));return Response.json({ok:true});
    }});failDecrypt(t,algorithm,original);
    await assert.rejects(f.session.signIn(0),error=>error===original);
    assert.equal(f.cleanupCalls().length,1);assert.deepEqual(f.locks,[original.message]);assertLocked(f);
  });
}
test('initial load failure erases an unwrapped master, records and session before one cleanup',async t=>{
  const original=new Error('最初の記録を読み込めませんでした');let unwrapped;
  const f=setup(t,{load:async state=>{unwrapped=state.auth.master;throw original;}});
  await assert.rejects(f.session.signIn(0),error=>error===original);
  assert.equal(f.cleanupCalls().length,1);assert.deepEqual(f.locks,[original.message]);assertLocked(f);
  assert.ok(unwrapped.every(byte=>byte===0));assert.ok(f.authPrf.every(byte=>byte===0));
});
test('invalid bundle still cleans up the issued session before createApi rejects the success schema',async t=>{
  const f=setup(t,{badBundle:true});await assert.rejects(f.session.signIn(0),/応答/);
  assert.equal(f.cleanupCalls().length,1);assert.equal(f.locks.length,1);assertLocked(f);
});
for(const failure of ['500','network']) {
  test(`cleanup ${failure} cannot replace the original unlock error or lock twice`,async t=>{
    const original=new Error('暗号鍵を解除できませんでした');
    const f=setup(t,{cleanup:()=>{if(failure==='network')throw new TypeError('synthetic network failure');return Response.json({error:'cleanup failed'},{status:500});}});
    failDecrypt(t,'AES-GCM',original);await assert.rejects(f.session.signIn(0),error=>error===original);
    assert.equal(f.cleanupCalls().length,1);assert.deepEqual(f.locks,[original.message]);assertLocked(f);assert.ok(f.authPrf.every(byte=>byte===0));
  });
}
test('hanging cleanup is aborted after two seconds without delaying lock or overwriting the login error',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const original=new Error('暗号鍵を解除できませんでした');let aborted=false;
  const f=setup(t,{cleanup:options=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('synthetic abort'));},{once:true}))});
  failDecrypt(t,'AES-GCM',original);const failed=assert.rejects(f.session.signIn(0),error=>error===original);
  await f.cleanupEntered;assertLocked(f);assert.deepEqual(f.locks,[original.message]);
  t.mock.timers.tick(2000);await failed;assert.equal(aborted,true);assert.equal(f.cleanupCalls().length,1);
});
test('generation change while receiving handoff still discards the issued session without resurrecting state',async t=>{
  const f=setup(t,{handoffResponse:state=>state.erase()});await assert.rejects(f.session.signIn(0),/画面を離れた/);
  assert.equal(f.cleanupCalls().length,1);assert.equal(f.locks.length,0);assertLocked(f);assert.ok(f.authPrf.every(byte=>byte===0));
});
for(const algorithm of ['AES-GCM','RSA-OAEP']) {
  test(`generation change during ${algorithm} completion prevents login and discards the old session`,async t=>{
    const f=setup(t),decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let decrypted;
    t.mock.method(crypto.subtle,'decrypt',async(...args)=>{const result=await decrypt(...args);if(args[0].name===algorithm){decrypted=new Uint8Array(result);f.state.erase();}return result;});
    await assert.rejects(f.session.signIn(0),/画面を離れた/);
    assert.equal(f.cleanupCalls().length,1);assert.equal(f.locks.length,0);assertLocked(f);
    assert.ok(decrypted.every(byte=>byte===0));assert.ok(f.authPrf.every(byte=>byte===0));
  });
}
test('generation change during initial load clears the unwrapped key and does not relock after cleanup',async t=>{
  let unwrapped;const f=setup(t,{load:async state=>{unwrapped=state.auth.master;state.erase();}});
  await assert.rejects(f.session.signIn(0),/画面を離れた/);assert.equal(f.cleanupCalls().length,1);assert.equal(f.locks.length,0);
  assertLocked(f);assert.ok(unwrapped.every(byte=>byte===0));
});
test('late cleanup failure has no invalidation callback and cannot erase another generation',async t=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;});
  const original=new Error('暗号鍵を解除できませんでした');const f=setup(t,{cleanup:async()=>{await gate;return Response.json({code:'session_changed',error:'cleanup failed'},{status:409});}});
  failDecrypt(t,'AES-GCM',original);const failed=assert.rejects(f.session.signIn(0),error=>error===original);
  await f.cleanupEntered;f.state.erase();f.state.auth.session='new-session';f.state.auth.accountId='new-account';f.state.auth.master=crypto.getRandomValues(new Uint8Array(32));
  finish();await failed;assert.equal(f.state.auth.session,'new-session');assert.equal(f.state.auth.accountId,'new-account');assert.ok(f.state.auth.master);
  assert.equal(f.cleanupCalls().length,1);assert.deepEqual(f.locks,[original.message]);
});
