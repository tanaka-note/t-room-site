import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertServiceProductionReady} from './service-production-preflight.mjs';
import {productionPlan,manualVerification} from './release-actions.mjs';
import {weeklyCommands,weeklySuites} from './weekly-regression.mjs';
test('Household/Calendar releases stay change-scoped and require prepared bindings and exact applied migration set',()=>{
 const context={event:'push',ref:'refs/heads/main',enabled:true};assert.deepEqual(productionPlan(['household','calendar'],context),['household','calendar']);
 for(const target of ['household','calendar'])assert.ok(manualVerification(target).includes(target));
 const config={d1_databases:[{binding:'DB',database_id:'fixture'}],vars:{PASSKEY_ENABLED:'true'},services:[{binding:'SECURITY',service:'t-room-security'}],queues:{producers:[{binding:'SECURITY_AUDIT',queue:'t-room-security-audit'}]}},settings={bindings:[{name:'DB',type:'d1',id:'fixture'},{name:'SESSION_SECRET',type:'secret_text'},{name:'SECURITY',type:'service',service:'t-room-security'},{name:'SECURITY_AUDIT',type:'queue'},{name:'PASSKEY_ENABLED',type:'secret_text'}]};
 for(const target of ['household','calendar']){assertServiceProductionReady(target,config,settings,['0001.sql'],['0001.sql']);assert.throws(()=>assertServiceProductionReady(target,config,settings,[],['0001.sql']));assert.throws(()=>assertServiceProductionReady(target,config,settings,['unexpected.sql'],['0001.sql']));for(const name of ['DB','SESSION_SECRET','SECURITY','SECURITY_AUDIT'])assert.throws(()=>assertServiceProductionReady(target,config,{bindings:settings.bindings.filter(b=>b.name!==name)},['0001.sql'],['0001.sql']));}
});
test('weekly suite is bounded, verification only, and Household WebKit is required by the CI gate',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/weekly-regression.yml',import.meta.url),'utf8'),verify=readFileSync(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
 assert.match(workflow,/schedule:/);assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/secrets\.|environment: production|release-actions|wrangler deploy/);
 const expected=['auth','backup','household','calendar','security','diary','payments','site','cloud'];
 assert.deepEqual(Object.keys(weeklySuites),expected);
 const matrix=workflow.match(/^\s*target: \[([^\]]+)\]/m);
 assert.ok(matrix,'The GitHub Actions matrix must declare its regression targets');
 assert.deepEqual(matrix[1].split(',').map(x=>x.trim()),expected,'Every weekly suite must have an Actions job');
 for(const target of ['household','calendar','diary','payments','security','backup','site']){
  assert.ok(weeklyCommands(target).length>0,`Missing released service: ${target}`);
 }
 assert.throws(()=>weeklyCommands('unknown'));
 assert.ok(weeklyCommands('household').some(c=>c.includes('household-worker/test/performance.mjs')));
 assert.ok(weeklyCommands('diary').some(c=>c.includes('diary-worker/tests/browser/session-clearing.mjs')));
 for(const target of ['payments','site','security']){
  const command=weeklyCommands(target).flat().join(' ');
  assert.match(command,/--browser/,'Missing browser regression: '+target);
  assert.match(command,/--build/,'Missing dry-run build: '+target);
 }
 assert.match(workflow,/pull_request:\s*\n\s*paths:/,'Changes to weekly regression must validate in PR CI');
 assert.match(workflow,/\bpayments\b/);
 assert.match(workflow,/\bsite\b/);

 assert.match(verify,/household-webkit-macos:/);assert.match(verify,/needs\.household-webkit-macos\.result/);assert.match(verify,/\$HOUSEHOLD_MACOS.*success\|skipped/);
});
