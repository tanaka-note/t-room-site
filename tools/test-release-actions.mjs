import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {prepareDiaryEncryption} from './prepare-diary-encryption.mjs';
import { productionPlan, manualVerification, assertActionsRelease, uploadedVersion, assertDeployedVersion, waitForProductionVerification, assertVersionSettings, assertDenied, checkTokenScope, assertD1ExportReadiness } from './release-actions.mjs';
import { affected } from './verify-plan.mjs';

test('Diary cannot switch to D1 exports before the central Workflow and Secret are provisioned',()=>{
  const settings={bindings:[{type:'workflow',name:'D1_BACKUPS',workflow_name:'t-room-d1-backup'},
    {type:'secret_text',name:'D1_EXPORT_API_TOKEN'}, {type:'plain_text',name:'D1_EXPORT_ACCOUNT_ID',text:'0'.repeat(32)},
    {type:'d1',name:'DIARY_DB',id:'e4677259-db4b-4562-ad82-fe542a1edb75'},
    {type:'d1',name:'PORTFOLIO_DB',id:'8fd0d41b-8ce2-42b8-a2e8-8c4461d08b32'},
    {type:'r2_bucket',name:'DIARY_BACKUP',bucket_name:'t-room-diary-backups'}]};
  assert.doesNotThrow(()=>assertD1ExportReadiness(settings));
  for(const binding of settings.bindings)assert.throws(()=>assertD1ExportReadiness({bindings:settings.bindings.filter(b=>b!==binding)}),/Prepare t-room-backup/);
  assert.throws(()=>assertD1ExportReadiness({bindings:settings.bindings.map(b=>b.type==='workflow'?{...b,workflow_name:'wrong'}:b)}));
  assert.throws(()=>assertD1ExportReadiness({bindings:settings.bindings.map(b=>b.name==='PORTFOLIO_DB'?{...b,id:'wrong'}:b)}));
});

test('production selects changed services only, never PR/branch/docs/tooling or disabled runs', () => {
  const context = { event: 'push', ref: 'refs/heads/main', enabled: true };
  assert.deepEqual(productionPlan(['tooling', 'cloud', 'auth'], context), ['cloud']);
  assert.deepEqual(productionPlan(['downloader', 'container-unit'], context), []);
  assert.deepEqual(productionPlan(['tooling'], context), []);
  assert.deepEqual(productionPlan(affected(['tcloud-windows/src/TCloud.Sync.Core/SyncPlanner.cs']), context), []);
  assert.deepEqual(affected(['tools/test-password-auth.mjs']), ['auth']);
  assert.deepEqual(productionPlan(affected(['tools/test-password-auth.mjs', 'billing-worker/public/billing.js', 'tools/verify-plan.mjs']), context), ['billing'],
    'Billing and shared authentication test changes must not publish the public site');
  assert.deepEqual(productionPlan(affected(['diary-worker/public/service-worker.js', 'tools/verify-plan.mjs']), context), ['diary'],
    'Diary shell updates must not publish the unrelated public site');
  for (const override of [{event:'pull_request'}, {ref:'refs/heads/codex/test'}, {enabled:false}]) {
    assert.deepEqual(productionPlan(['site'], {...context,...override}), []);
  }
  assert.deepEqual(productionPlan(['site','cloud'], {...context,event:'workflow_dispatch',requested:'diary'}), ['diary']);
  assert.deepEqual(productionPlan(['site'], {...context,event:'workflow_dispatch'}), []);
  assert.throws(() => productionPlan([], {...context,event:'workflow_dispatch',requested:'../../evil'}));
  for (const target of ['downloader', 'downloader2', 'ai', 'health']) {
    assert.deepEqual(productionPlan([target],context), []);
    assert.throws(() => manualVerification(target), /Unknown production target/);
  }
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
test('post-promotion readback waits for the exact version at 100% and rejects a permanently stale or split deployment', async () => {
  const version='12345678-1234-1234-1234-123456789abc';
  const deployment = versions => ({deployments:[{versions}]});
  const pending = [deployment([{version_id:'previous',percentage:100}]),
    deployment([{version_id:version,percentage:50},{version_id:'previous',percentage:50}]),
    deployment([{version_id:version,percentage:100}])];
  const delays=[];
  await waitForProductionVerification(() => assertDeployedVersion(pending.shift(),version), {
    sleep: async ms => delays.push(ms)
  });
  assert.deepEqual(delays,[5000,5000]);
  assert.equal(pending.length,0);
  for (const stale of [deployment([{version_id:'previous',percentage:100}]),
    deployment([{version_id:version,percentage:50}]),deployment([])]) {
    let reads=0,sleeps=0;
    await assert.rejects(waitForProductionVerification(() => {
      reads++; assertDeployedVersion(stale,version);
    },{attempts:3,sleep:async()=>{sleeps++;}}),/not serving the uploaded version at 100%/);
    assert.equal(reads,3);assert.equal(sleeps,2);
  }
});
test('public build propagation is retried within a bound and never turns a persistent mismatch into success', async () => {
  let reads=0;
  const checked=await waitForProductionVerification(() => {
    if(++reads<3)throw new Error('Production command failed.');
    return 'verified expected build';
  },{attempts:6,sleep:async()=>{}});
  assert.equal(checked,'verified expected build');assert.equal(reads,3);
  reads=0;
  await assert.rejects(waitForProductionVerification(() => {
    reads++;throw new Error('Production command failed.');
  },{attempts:6,sleep:async()=>{}}),/Production command failed/);
  assert.equal(reads,6);
});
test('code release refuses infrastructure changes instead of silently ignoring them', () => {
  const before={routes:[{pattern:'example.test/*'}],triggers:{crons:['0 * * * *']},queues:{consumers:[{queue:'existing'}]}};
  assertVersionSettings(before,{...before,compatibility_date:'2026-10-21',vars:{FEATURE:'true'}});
  for (const key of ['routes','workers_dev','triggers','migrations']) assert.throws(()=>assertVersionSettings(before,{...before,[key]:['changed']}));
  assert.throws(()=>assertVersionSettings(before,{...before,queues:{consumers:[]}}));
});
test('production gates explicitly handle skipped upstream service jobs', () => {
  const workflow=readFileSync(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
  const gate=workflow.split('\n  production:')[1].split('\n    environment:')[0];
  assert.match(gate,/!cancelled\(\)/);
  assert.match(gate,/needs\.verify\.result == 'success'/);
  assert.match(gate,/github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow,/clamav|downloader-production|downloader2-native/i);
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
  assert.equal(calls.length, 12, 'account subdomain, 9 selected Workers, D1 and R2');
  assert.equal(calls.filter(path => path.endsWith('/settings')).length, 9);
  assert.equal(logs.some(message => message.includes('fixture-token')), false);
  const deniedCalls = [];
  await assert.rejects(checkTokenScope({...options, read: async path => {
    deniedCalls.push(path); throw new Error('Cloudflare verification failed (HTTP 403).');
  }}), /HTTP 403/);
  assert.equal(deniedCalls.length, 1, 'fail before any other work when account read permission is absent');
  await assert.rejects(checkTokenScope({...options, request: async () => ({status:200,json:async()=>({success:true})})}), /denial not established/);
});


test('Diary preparation rejects unverified context, unknown schema and existing cutover before any mutation',async()=>{
  const context={sha:'a'.repeat(40),ref:'refs/heads/main',event:'infrastructure',account:'277e86de986181599ce0db2b3ca1f186',clean:true};
  const verification={sha:context.sha,conclusion:'success',event:'push',branch:'main'};
  const calls=[];
  const options={context,verification,loadSchema:async()=>{calls.push('read');return [];},deployBackup:async()=>{calls.push('deploy');},readControl:async()=>({phase:'encrypted',generation:1,ever_encrypted:1})};
  for(const change of [{clean:false},{ref:'refs/heads/feature'},{event:'push'},{account:'0'.repeat(32)},{sha:'b'.repeat(40)}])await assert.rejects(prepareDiaryEncryption({...options,context:{...context,...change}}));
  assert.equal(calls.length,0);
  await assert.rejects(prepareDiaryEncryption({...options,verification:{...verification,conclusion:'failure'}}),/PassingCI/);assert.equal(calls.length,0);
  await assert.rejects(prepareDiaryEncryption(options),/SchemaReviewRequired/);assert.deepEqual(calls,['read']);
});

test('Diary preparation deploys the verified Backup Worker before additive SQL and never changes source data or rollout',async()=>{
  const databases={};
  try {
    for(const service of ['security','diary']) {
      const db=databases[service]=new DatabaseSync(':memory:'),dir=new URL(`../${service}-worker/migrations/`,import.meta.url);
      for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
    }
    databases.diary.exec("INSERT INTO diary_entries(entry_date,title,content) VALUES('2026-11-15','Untouched title','Untouched private content')");
    const events=[],version='12345678-1234-1234-1234-123456789abc';
    const context={sha:'a'.repeat(40),ref:'refs/heads/main',event:'infrastructure',account:'277e86de986181599ce0db2b3ca1f186',clean:true};
    const options={context,verification:{sha:context.sha,conclusion:'success',event:'push',branch:'main'},
      loadSchema:async service=>databases[service].prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all(),
      readControl:async()=>databases.diary.prepare('SELECT * FROM diary_e2ee_control').get(),
      deployBackup:async()=>{events.push('deploy');return version;},verifyBackup:async()=>{events.push('verify');},
      applyCandidate:async service=>{events.push(service);for(const file of service==='security'?['e2ee/diary-keys.sql']:['e2ee/schema.sql','e2ee/legacy-fences.sql'])databases[service].exec(readFileSync(new URL(`../${service}-worker/${file}`,import.meta.url),'utf8'));}
    };
    const result=await prepareDiaryEncryption(options);
    assert.deepEqual(events,['deploy','verify','security','diary']);assert.equal(result.dataMigration,false);assert.equal(result.encryptionEnabled,false);
    assert.equal(databases.diary.prepare('SELECT content FROM diary_entries').get().content,'Untouched private content');
    events.length=0;await prepareDiaryEncryption(options);assert.deepEqual(events,['deploy','verify']);
    events.length=0;await assert.rejects(prepareDiaryEncryption({...options,guard:async()=>{throw new Error('MainAdvanced');}}),/MainAdvanced/);assert.deepEqual(events,[]);
    databases.diary.exec("UPDATE diary_e2ee_control SET phase='migrating',generation=1");events.length=0;
    await assert.rejects(prepareDiaryEncryption(options),/UntouchedLegacy/);assert.deepEqual(events,[]);
  }finally{for(const db of Object.values(databases))db.close();}
});
