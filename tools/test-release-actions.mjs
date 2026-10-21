import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productionPlan, manualVerification, assertActionsRelease, uploadedVersion, assertDeployedVersion, assertVersionSettings, assertDenied, checkTokenScope } from './release-actions.mjs';

test('production selects changed services only, never PR/branch/docs/tooling or disabled runs', () => {
  const context = { event: 'push', ref: 'refs/heads/main', enabled: true };
  assert.deepEqual(productionPlan(['tooling', 'cloud', 'auth'], context), ['cloud']);
  assert.deepEqual(productionPlan(['downloader', 'container-unit'], context), ['downloader']);
  assert.deepEqual(productionPlan(['tooling'], context), []);
  for (const override of [{event:'pull_request'}, {ref:'refs/heads/codex/test'}, {enabled:false}]) {
    assert.deepEqual(productionPlan(['site'], {...context,...override}), []);
  }
  assert.deepEqual(productionPlan(['site','cloud'], {...context,event:'workflow_dispatch',requested:'diary'}), ['diary']);
  assert.deepEqual(productionPlan(['site'], {...context,event:'workflow_dispatch'}), []);
  assert.throws(() => productionPlan([], {...context,event:'workflow_dispatch',requested:'../../evil'}));
  assert.ok(manualVerification('security').includes('auth'));
  assert.deepEqual(manualVerification('site'), ['site']);
});
test('CI bypass is rejected unless successful CI and checkout are the same main SHA', () => {
  const head='a'.repeat(40);
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'tanaka-note/t-room-site',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'push',TROOM_CI_RESULT:'success',GITHUB_SHA:head,TROOM_VERIFIED_SHA:head};
  assert.doesNotThrow(() => assertActionsRelease(env,head));
  for (const key of Object.keys(env)) assert.throws(() => assertActionsRelease({...env,[key]:'invalid'},head),key);
});
test('promotion is pinned to a unique uploaded Worker/version and read back at 100%', () => {
  const version='12345678-1234-1234-1234-123456789abc';
  const upload={type:'version-upload',worker_name:'t-room-site',version_id:version};
  assert.equal(uploadedVersion(JSON.stringify(upload),'t-room-site'),version);
  assert.equal(uploadedVersion(JSON.stringify({...upload,type:'deploy',worker_name:'t-room-downloader'}),'t-room-downloader','deploy'),version);
  assert.throws(() => uploadedVersion(JSON.stringify(upload),'t-room-cloud'));
  assert.throws(() => uploadedVersion(JSON.stringify(upload)+'\n'+JSON.stringify(upload),'t-room-site'));
  assert.throws(() => uploadedVersion(JSON.stringify({...upload,version_id:'latest'}),'t-room-site'));
  assertDeployedVersion({deployments:[{versions:[{version_id:version,percentage:100}]}]},version);
  for (const deployments of [[],[{versions:[{version_id:'different',percentage:100}]}],[{versions:[{version_id:version,percentage:50}]}]]) {
    assert.throws(() => assertDeployedVersion({deployments},version));
  }
});
test('code release refuses infrastructure changes instead of silently ignoring them', () => {
  const before={routes:[{pattern:'example.test/*'}],triggers:{crons:['0 * * * *']},queues:{consumers:[{queue:'existing'}]}};
  assertVersionSettings(before,{...before,compatibility_date:'2026-10-21',vars:{FEATURE:'true'}});
  for (const key of ['routes','workers_dev','triggers','migrations']) assert.throws(()=>assertVersionSettings(before,{...before,[key]:['changed']}));
  assert.throws(()=>assertVersionSettings(before,{...before,queues:{consumers:[]}}));
});
test('production gates explicitly handle skipped upstream service jobs', () => {
  const workflow=readFileSync(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
  for (const job of ['production','downloader-production']) {
    const gate=workflow.split(`\n  ${job}:`)[1].split('\n    environment:')[0].split('\n    permissions:')[0];
    assert.match(gate,/!cancelled\(\)/);
    assert.match(gate,/needs\.verify\.result == 'success'/);
    assert.match(gate,/github\.ref == 'refs\/heads\/main'/);
  }
  assert.match(workflow,/manual \|\| selected\.includes\('container-unit'\)/);
  assert.match(workflow,/clamav-definition-update/);
  assert.match(readFileSync(new URL('./release-actions.mjs',import.meta.url),'utf8'),/--containers-rollout=none/);
});
test('scope checks accept product-specific authorization denials, never success or a missing endpoint', () => {
  for (const status of [401,403]) assertDenied(status,{success:false,errors:[{code:10000}]});
  for (const status of [200,404,429,500]) assert.throws(()=>assertDenied(status,{success:false}));
  assert.throws(()=>assertDenied(403,{success:true}));
  assert.throws(()=>assertDenied(403,null));
});

test('token preflight requires account subdomain access and checks only read operations', async () => {
  const calls = [], logs = [];
  const options = {
    env: { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-token' },
    read: async path => { calls.push(path); return {}; },
    request: async (url, init) => {
      assert.equal(init.method, undefined, 'scope probes must use GET');
      calls.push(url);
      return { status: url.endsWith('/d1/database') ? 401 : 403, json: async () => ({success:false}) };
    },
    log: message => logs.push(message)
  };
  await checkTokenScope(options);
  assert.match(calls[0], /\/workers\/subdomain$/);
  assert.equal(calls.length, 14, 'account subdomain, 11 selected Workers, D1 and R2');
  assert.equal(calls.filter(path => path.endsWith('/settings')).length, 11);
  assert.equal(logs.some(message => message.includes('fixture-token')), false);
  const deniedCalls = [];
  await assert.rejects(checkTokenScope({...options, read: async path => {
    deniedCalls.push(path); throw new Error('Cloudflare verification failed (HTTP 403).');
  }}), /HTTP 403/);
  assert.equal(deniedCalls.length, 1, 'fail before any other work when account read permission is absent');
  await assert.rejects(checkTokenScope({...options, request: async () => ({status:200,json:async()=>({success:true})})}), /denial not established/);
});
