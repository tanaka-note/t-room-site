import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInfrastructure, infrastructureChecks } from './check-cloud-infrastructure.mjs';
import { affected } from './verify-plan.mjs';

const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_ZONE_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-credential' };
test('infrastructure tooling does not trigger site or service deployment', () => {
  for (const path of ['tools/check-cloud-infrastructure.mjs','tools/test-cloud-infrastructure.mjs']) assert.deepEqual(affected([path]),['tooling']);
});
test('infrastructure probes only GET metadata and never print resources or credentials', async () => {
  const calls = [], logs = [];
  await checkInfrastructure({env,log:line=>logs.push(line),request:async (url,options)=>{
    calls.push(url);
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,`Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    assert.equal(options.body,undefined);
    assert.equal(new URL(url).origin,'https://api.cloudflare.com');
    return {ok:true,status:200,json:async()=>({success:true,result:[{name:'private-fixture-name'}]})};
  }});
  assert.equal(calls.length,8);
  assert.equal(new Set(calls).size,8);
  assert.equal(logs.length,8);
  assert.doesNotMatch(logs.join('\n'),/fixture-credential|private-fixture-name/);
});
test('invalid configuration is rejected before sending credentials', async () => {
  for (const key of Object.keys(env)) {
    await assert.rejects(checkInfrastructure({env:{...env,[key]:''},request:()=>assert.fail('must not request')}));
  }
  assert.throws(()=>infrastructureChecks('../../other',env.CLOUDFLARE_ZONE_ID));
});
test('HTTP denial, unsuccessful JSON and network failure fail without exposing error contents', async () => {
  for (const request of [
    async()=>({ok:false,status:403,json:async()=>({success:false,errors:[{message:'fixture-credential'}]})}),
    async()=>({ok:true,status:200,json:async()=>({success:false})}),
    async()=>{throw new Error('fixture-credential');}
  ]) {
    const logs=[];
    await assert.rejects(checkInfrastructure({env,request,log:line=>logs.push(line)}),/Infrastructure access check failed/);
    assert.equal(logs.length,8);
    assert.doesNotMatch(logs.join('\n'),/fixture-credential/);
  }
});
