import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {systemFixture} from './system-fixture.mjs';
import {prepareDiaryKeys} from '../../public/diary-key-preparation.js';
import {takePreparedVault,unlockSession} from '../../e2ee/session.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';

let f,trust;
before(async()=>{f=await systemFixture();trust=await publicTrustPackage(f.configuration);});
after(async()=>{await f?.close();});
function apiFor(account) {
  const cookie=f.cookie(account),origin=f.env.DIARY_ENCRYPTION_ORIGIN;
  return async(path,options={})=>{
    const method=options.method||'GET';
    const response=await f.worker.fetch(new Request(origin+'/diary/api'+path,{method,headers:{Cookie:cookie,...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-Diary-Request':'1'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})}),f.env,f.ctx);
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;
  };
}
const authentication=account=>({credentialId:f.users[account].credentialId,prfOutput:new Uint8Array(f.users[account].prf),handoff:{diaryTrust:trust}});

test('prepared non-extractable keys are consumed once, with both live checks and fresh signed grants',async()=>{
  const api=apiFor('main-user'),auth=authentication('main-user');
  await prepareDiaryKeys(api,await api('/session'),auth);
  const {profile}=await api('/encryption/profile'),privateKeys=auth.diaryPreparedKeys.privateKeys;
  const cachedPrivateKeys=takePreparedVault(auth,profile);
  assert.equal(cachedPrivateKeys,privateKeys);assert.equal(auth.diaryPreparedKeys,null);assert.equal(takePreparedVault(auth,profile),undefined);
  let checks=0;
  const state=await unlockSession({prf:auth.prfOutput,cachedPrivateKeys,profile,anchor:trust.anchor,minimumGeneration:trust.minimumGeneration,checkSession:async()=>{checks++;return true;}});
  assert.equal(checks,2);assert.equal(state.privateKeys,privateKeys);assert.equal(privateKeys.rsa.extractable,false);assert.equal(privateKeys.sign.extractable,false);assert.ok(state.keys.size>0);assert.ok(auth.prfOutput.every(value=>value===0));
  state.keys.clear();state.privateKeys=null;
});

test('a different account, credential, recipient or vault cannot consume prepared keys; failed preparation clears its carrier',async()=>{
  const api=apiFor('main-user'),auth=authentication('main-user');await prepareDiaryKeys(api,await api('/session'),auth);
  const {profile}=await api('/encryption/profile'),saved=auth.diaryPreparedKeys;
  const variants=[
    {...profile,actor:{...profile.actor,accountId:'other-account'}},
    {...profile,webAuthnCredentialId:'other-passkey'},
    {...profile,actor:{...profile.actor,credentialId:'other-recipient'}},
    {...profile,vault:{...profile.vault,publicKey:{...profile.vault.publicKey,n:'changed'}}},
    {...profile,vault:{...profile.vault,privateEnvelope:{...profile.vault.privateEnvelope,iv:'AAAAAAAAAAAAAAAA'}}}
  ];
  for(const changed of variants){auth.diaryPreparedKeys=saved;assert.equal(takePreparedVault(auth,changed),undefined);assert.equal(auth.diaryPreparedKeys,null);}
  auth.diaryPreparedKeys=saved;
  await assert.rejects(prepareDiaryKeys(async()=>{throw new Error('NetworkUnavailable');},await api('/session'),auth),/NetworkUnavailable/);
  assert.equal(auth.diaryPreparedKeys,null);auth.prfOutput.fill(0);
});

test('prepared keys cannot bypass revocation after cryptographic validation',async()=>{
  const api=apiFor('main-user'),auth=authentication('main-user');await prepareDiaryKeys(api,await api('/session'),auth);
  const {profile}=await api('/encryption/profile');let checks=0;
  await assert.rejects(unlockSession({prf:auth.prfOutput,cachedPrivateKeys:takePreparedVault(auth,profile),profile,anchor:trust.anchor,minimumGeneration:trust.minimumGeneration,checkSession:async()=>++checks===1}),/SessionExpired/);
  assert.equal(checks,2);assert.equal(auth.diaryPreparedKeys,null);assert.ok(auth.prfOutput.every(value=>value===0));
});

test('independent owner reads overlap, and a vault write requires a newer admin inventory', {timeout:10000},async()=>{
  const native=apiFor('main-admin'),session=await native('/session');
  for(const changed of [false,true]) {
    let release,adminReads=0,writes=0;
    const gate=new Promise(resolve=>{release=resolve;});
    const api=async(path,options)=>{
      if(path==='/encryption/manage/own'){
        await gate;const own=await native(path,options);
        return changed?{...own,links:own.links.map((link,i)=>i===0?{...link,prepared:false}:link)}:own;
      }
      if(path==='/encryption/manage/admin'){adminReads++;release();if(adminReads>1)assert.ok(writes>0);}
      if(path==='/encryption/manage/vault'){writes++;return {prepared:true};}
      return native(path,options);
    };
    const auth=authentication('main-admin');
    try{await prepareDiaryKeys(api,session,auth);assert.equal(adminReads,changed?2:1);assert.equal(writes,changed?1:0);}
    finally{release();auth.prfOutput.fill(0);auth.diaryPreparedKeys=null;}
  }
});
