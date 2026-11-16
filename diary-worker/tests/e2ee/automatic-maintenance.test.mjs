import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {systemFixture} from './system-fixture.mjs';
import {diaryAutomaticManagement} from '../../../security-worker/src/diary-keys.js';
import {transitionRollout} from '../../e2ee/rollout.mjs';

test('migration continuation is bounded to the fresh owner session, current generations and fixed operations; every call revalidates revocation',async()=>{
  const f=await systemFixture({phase:'legacy'}),u=f.users['main-admin'],now=Date.now;
  const input={...u,service:'diary',authMethod:'passkey',startedAt:new Date().toISOString(),sessionId:crypto.randomUUID(),passkeySessionEpoch:1,accountVersion:1};
  const valid=async()=>({valid:true});
  const call=(path,value,override={})=>diaryAutomaticManagement(f.centralEnv,{...input,path,value,...override},valid);
  try {
    await assert.rejects(call('/maintenance/authorize',{}),/AuthorizationInvalid/);
    f.db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
    await call('/control',{next:'migrating',expectedGeneration:0,evidence:null});
    const {authorization}=await call('/maintenance/authorize',{}),lease={maintenanceAuthorization:authorization};
    const begun=Date.now();Date.now=()=>begun+600000;
    await assert.rejects(call('/admin'),/RecentAuthentication/);
    assert.equal((await call('/admin',undefined,lease)).rollout.phase,'migrating');
    await assert.rejects(call('/config',{},lease),/RouteDenied/);
    await assert.rejects(call('/control',{next:'legacy',expectedGeneration:1,evidence:null},lease),/RouteDenied/);
    await assert.rejects(call('/rotation/begin',{},lease),/UnknownDiaryAutomaticRoute/);
    await assert.rejects(call('/admin',undefined,{...lease,sessionId:'other-session'}),/AuthorizationInvalid/);
    await assert.rejects(call('/admin',undefined,{...lease,passkeySessionEpoch:2}),/AuthorizationInvalid/);
    await assert.rejects(call('/admin',undefined,{...lease,maintenanceAuthorization:authorization.slice(0,-3)+'xxx'}),/AuthorizationInvalid/);
    await assert.rejects(diaryAutomaticManagement(f.centralEnv,{...input,path:'/admin',...lease},async()=>({valid:false})),/SessionInvalid/);
    f.central.sqlite.exec('UPDATE security_diary_key_config SET generation=generation+1');
    await assert.rejects(call('/admin',undefined,lease),/AuthorizationInvalid/);
    f.central.sqlite.exec('UPDATE security_diary_key_config SET generation=generation-1');
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(u.credentialId);
    await assert.rejects(call('/admin',undefined,lease),/SessionInvalid/);
    f.central.sqlite.prepare("UPDATE security_credentials SET status='active' WHERE credential_id=?").run(u.credentialId);
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(f.users['wife-admin'].credentialId);
    await assert.rejects(call('/control',{next:'encrypted',expectedGeneration:1,evidence:null},lease),/RekeyRequired/);
    f.central.sqlite.prepare("UPDATE security_credentials SET status='active' WHERE credential_id=?").run(f.users['wife-admin'].credentialId);
    Date.now=()=>begun+3600001;
    await assert.rejects(call('/admin',undefined,lease),/AuthorizationInvalid/);
    Date.now=()=>begun+600000;
    f.db.sqlite.exec('UPDATE diary_e2ee_control SET generation=generation+1');
    await assert.rejects(call('/admin',undefined,lease),/AuthorizationInvalid/);
    await assert.rejects(call('/maintenance/authorize',{}),/RecentAuthentication/);
    await assert.rejects(diaryAutomaticManagement(f.centralEnv,{...input,...f.users['main-user'],path:'/control',value:{next:'migrating',expectedGeneration:2,evidence:null}},valid),/AccessDenied/);
  }finally{Date.now=now;await f.close();}
});

test('initial automatic migration does not freeze an active legacy photo upload',async()=>{
  const f=await systemFixture({phase:'legacy'}),u=f.users['main-admin'];
  try {
    f.db.sqlite.exec("INSERT INTO diary_photo_upload_sessions(id,account_id,household_id,status,expires_at) VALUES('in-flight','main-admin','tanaka-household','active','2999-01-01T00:00:00.000Z')");
    const actor={...u.claims,credentialId:u.recipientId,reauthenticatedAt:Date.now()/1000};
    await assert.rejects(transitionRollout(f.db,{actor,expectedGeneration:0,next:'migrating'}),/RolloutConflict/);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'legacy');
  }finally{await f.close();}
});

test('an interrupted checkpoint retries its fixed workflow without replacing good backups',async()=>{
  const f=await systemFixture({phase:'legacy'});let restarted=0;
  try {
    f.db.sqlite.exec("UPDATE diary_e2ee_control SET phase='migrating',generation=1");
    f.env.D1_BACKUPS={create:async()=>{throw new Error('WorkflowExists');},get:async()=>({status:async()=>({status:'errored'}),restart:async()=>{restarted++;}})};
    const result=await f.integration.createEncryptionCheckpoint({directoryGeneration:1});
    assert.equal(restarted,1);assert.match(result.key,/^v10\/checkpoints\//);
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
    f.env.D1_BACKUPS.get=async()=>({status:async()=>({status:'terminated'})});
    await assert.rejects(f.integration.createEncryptionCheckpoint({directoryGeneration:1}),/CheckpointFailed/);
  }finally{await f.close();}
});
