import assert from 'node:assert/strict';
import {test} from 'node:test';
import {systemFixture} from './system-fixture.mjs';
import {prepareDiaryKeys} from '../../public/diary-key-preparation.js';
import {createVault} from '../../e2ee/crypto.mjs';
import {diaryAutomaticVault} from '../../../security-worker/src/diary-keys.js';

test('normal Diary login prepares only its own sealed vault without Security UI, preserves it after response loss and grants no data access',async()=>{
  const f=await systemFixture({phase:'legacy'}),user=f.users['main-user'],wire=[];
  let cookie=f.cookie('main-user'),lose=true;
  const request=async(path,options={})=>{
    const method=options.method||'GET',url='https://tanaka-note.com/diary/api'+path;
    wire.push(options.body||{});
    const response=await f.worker.fetch(new Request(url,{method,headers:{Cookie:cookie,...(method==='POST'?{Origin:'https://tanaka-note.com','Content-Type':'application/json','X-Diary-Request':'1'}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})}),f.env,f.ctx);
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});
    if(method==='POST'&&lose){lose=false;throw new Error('SyntheticResponseLoss');}return result;
  };
  try {
    f.central.sqlite.prepare('DELETE FROM security_diary_key_grants WHERE recipient_id=?').run(user.recipientId);
    f.central.sqlite.prepare('DELETE FROM security_diary_key_vaults WHERE recipient_id=?').run(user.recipientId);
    const session={encryption:{accountId:'main-user'}},authentication={credentialId:user.credentialId,prfOutput:new Uint8Array(user.prf)};
    await assert.rejects(prepareDiaryKeys(request,session,authentication),/SyntheticResponseLoss/);
    const saved=f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(user.recipientId).vault_json;
    assert.deepEqual(await prepareDiaryKeys(request,session,authentication),{prepared:true});
    assert.equal(f.central.sqlite.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').get(user.recipientId).vault_json,saved);
    assert.equal(f.central.sqlite.prepare('SELECT COUNT(*) count FROM security_diary_key_grants WHERE recipient_id=?').get(user.recipientId).count,0);
    assert.equal(JSON.stringify(wire).includes(Buffer.from(user.prf).toString('base64')),false);
    assert.equal(JSON.stringify(wire).includes('privateKey'),false);
    const replacement=await createVault(user.prf,user.recipientId);
    // A competing preparation cannot replace the first immutable vault.
    const raced=await request('/encryption/prepare',{method:'POST',body:{recipientId:user.recipientId,vault:replacement}});
    assert.equal(JSON.stringify(raced.vault),saved);
    await assert.rejects(request('/encryption/prepare',{method:'POST',body:{recipientId:f.users['main-admin'].recipientId,vault:replacement}}),error=>error.status===403);
    cookie=f.cookie('wife-admin');
    await assert.rejects(prepareDiaryKeys(request,session,authentication),error=>error.sessionChanged===true);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'legacy');
    authentication.prfOutput.fill(0);
  }finally{await f.close();}
});

test('automatic preparation enforces live session, recent authentication and the dedicated origin after cutover',async()=>{
  const f=await systemFixture(),u=f.users['main-user'];
  const input={...u,service:'diary',authMethod:'passkey',startedAt:new Date().toISOString(),passkeySessionEpoch:1};
  const valid=async()=>({valid:true});
  try {
    const preparation={recipientId:u.recipientId,vault:u.vault};
    await assert.rejects(diaryAutomaticVault(f.centralEnv,{...input,preparation,startedAt:new Date(Date.now()-301000).toISOString()},valid),/RecentAuthentication/);
    await assert.rejects(diaryAutomaticVault(f.centralEnv,{...input,preparation,startedAt:new Date(Date.now()+60000).toISOString()},valid),/RecentAuthentication/);
    await assert.rejects(diaryAutomaticVault(f.centralEnv,{...input,service:'household'},valid),/SessionInvalid/);
    await assert.rejects(diaryAutomaticVault(f.centralEnv,input,async()=>({valid:false})),/SessionInvalid/);
    f.central.sqlite.prepare("UPDATE security_service_links SET status='disabled' WHERE id=?").run(u.serviceLinkId);
    await assert.rejects(diaryAutomaticVault(f.centralEnv,input,valid),/SessionInvalid/);
    const response=await f.worker.fetch(new Request('https://tanaka-note.com/diary/api/encryption/prepare',{headers:{Cookie:f.cookie('main-user')}}),f.env,f.ctx);
    assert.equal(response.status,403);
  }finally{await f.close();}
});

test('normal login defers automatic app reload until key preparation and migration finish',async()=>{
  const f=await systemFixture({phase:'legacy'}),u=f.users['main-user'],previous=globalThis.document,target=new EventTarget();
  globalThis.document=target;let checks=0;
  const event=()=>new Event('troom:before-auto-update',{cancelable:true});
  const api=async()=>{
    const update=event();target.dispatchEvent(update);assert.equal(update.defaultPrevented,true);checks++;
    return {accountId:'main-user',webAuthnCredentialId:u.credentialId,recipientId:u.recipientId,vault:u.vault};
  };
  try {
    const session={encryption:{accountId:'main-user'}},auth={credentialId:u.credentialId,prfOutput:new Uint8Array(u.prf)};
    await prepareDiaryKeys(api,session,auth);assert.ok(checks);
    const update=event();target.dispatchEvent(update);assert.equal(update.defaultPrevented,false);
    await assert.rejects(prepareDiaryKeys(async()=>{throw new Error('NetworkUnavailable');},session,auth),/NetworkUnavailable/);
    const failed=event();target.dispatchEvent(failed);assert.equal(failed.defaultPrevented,false);
    auth.prfOutput.fill(0);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;await f.close();}
});
