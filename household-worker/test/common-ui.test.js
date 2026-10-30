import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './fixture.js';

test('household date selectors use the same calendar and wheel assets as Payments',()=>{
  for(const file of ['troom-date-picker.js','troom-date-picker.css','date-wheel.js','date-wheel.css']) {
    assert.equal(readFileSync(new URL(`../public/${file}`,import.meta.url),'utf8'),readFileSync(new URL(`../../payments-worker/public/${file}`,import.meta.url),'utf8'));
  }
});

test('passkey login and account chooser styling matches Billing',()=>{
  const css=readFileSync(new URL('../public/household.css',import.meta.url),'utf8'),billing=readFileSync(new URL('../../billing-worker/public/billing.css',import.meta.url),'utf8');
  const chooser=billing.slice(billing.indexOf('.troom-passkey-account-dialog {'),billing.indexOf('/* Keep the login action'));
  assert.ok(css.includes(chooser));
  for(const rule of billing.matchAll(/button\.passkey-login-button[^{}]*\{[^{}]*\}/g))assert.ok(css.includes(rule[0]));
});

test('shared date assets are routed and new account links cannot be created',async()=>{
  const f=fixture();try{
    for(const file of ['troom-date-picker.js','troom-date-picker.css','date-wheel.js','date-wheel.css'])assert.equal((await f.request(`/${file}`)).status,200);
    await f.login();const before=await f.state(),account=before.data.accounts[0];
    assert.equal((await f.mutate('account.save',{...account,asOf:'2026-09-30',historyId:'legacy-bank'})).status,400);
    assert.deepEqual(await f.state(),before);
  }finally{f.close();}
});
