import assert from 'node:assert/strict';
import {chromium,devices} from 'playwright';
import {loginStartupFixture} from './login-startup-fixture.mjs';

const f=await loginStartupFixture(),browser=await chromium.launch({headless:true});
const profilePath='/diary/api/encryption/profile';
const entryCard='#entry-list .diary-entry-card';
try {
  for(const scenario of ['parallel','asset-retry','profile-change','revoked']) {
    const context=await browser.newContext(devices['Pixel 7']);await f.configure(context);
    const page=await context.newPage(),errors=[],assets=[];let release=()=>{};
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(new URL(request.url()).pathname==='/diary/diary.js')assets.push(request.url());});
    try {
      await page.goto(f.origin+'/diary/');await page.locator('#passkey-login').waitFor({state:'visible'});
      assert.equal(assets.length,0,'protected app code is not loaded before authentication');
      const before=f.wire.length;
      if(scenario==='profile-change') {
        await page.route('**'+profilePath,async route=>{
          const response=await route.fetch(),value=await response.json();
          value.profile.vault.privateEnvelope.ciphertext=value.profile.vault.privateEnvelope.ciphertext.replace(/^./,c=>c==='A'?'B':'A');
          await route.fulfill({response,json:value});
        });
        await page.click('#passkey-login');
        await page.waitForFunction(()=>!document.querySelector('#passkey-login').disabled&&window.loginAuthentication?.prfOutput.every(value=>value===0));
        assert.equal(await page.locator('#app-view').isVisible(),false);
        assert.equal(await page.evaluate(()=>window.loginMetrics.vaultDecrypts),1,'the modified profile vault fails decryption before any view opens');
      }else {
        let held,assetFailed;
        const holding=new Promise(resolve=>{held=resolve;}),gate=new Promise(resolve=>{release=resolve;});
        await page.route('**'+profilePath,async route=>{held();await gate;await route.continue();});
        const failed=new Promise(resolve=>{assetFailed=resolve;});
        if(scenario==='asset-retry')await page.route('**/dialog-navigation.js?*',async route=>{await route.fulfill({status:503,body:'Synthetic asset failure'});assetFailed();});
        const imported=page.waitForRequest(request=>new URL(request.url()).pathname==='/diary/diary.js');
        await page.click('#passkey-login');await holding;await imported;
        assert.equal(await page.locator('#app-view').isVisible(),false,'loading modules must not expose the app before preparation');
        assert.equal(f.wire.slice(before).some(row=>row.path===profilePath),false);
        if(scenario==='asset-retry')await failed;
        assert.equal(await page.evaluate(()=>window.loginAuthentication.prfOutput.some(value=>value!==0)),true,'an early asset error must not clear PRF while preparation is still using it');
        if(scenario==='revoked')f.user.active=false;
        release();
        if(scenario==='parallel') {
          await page.locator(entryCard).first().waitFor({state:'visible'});
          const metrics=await page.evaluate(()=>window.loginMetrics),start=metrics.requests.indexOf('/diary/api/passkey/handoff');
          assert.equal(metrics.requests.filter(path=>path===profilePath).length,1);
          assert.equal(metrics.requests.includes('/diary/api/encryption/prepare'),false);
          assert.equal(metrics.vaultDecrypts,1,'one vault decryption for preparation and application startup combined');
          assert.equal(metrics.requests.slice(start+1).filter(path=>path==='/diary/api/session').length,4,'both live checks for unlock and for initial snapshot remain');
        }else {
          await page.waitForFunction(()=>!document.querySelector('#passkey-login').disabled&&document.querySelector('#login-message').textContent);
          assert.equal(await page.locator('#app-view').isVisible(),false);
          assert.equal(f.wire.slice(before).filter(row=>row.path===profilePath).length,1);
          assert.equal(f.wire.slice(before).some(row=>row.path.startsWith('/diary/api/encryption/snapshot')),false);
          assert.equal(await page.evaluate(()=>window.loginAuthentication.diaryPreparedKeys),null);
          if(scenario==='asset-retry') {
            assert.equal(await page.evaluate(()=>window.loginAuthentication.prfOutput.every(value=>value===0)),true);
            await page.unroute('**/dialog-navigation.js?*');await page.unroute('**'+profilePath);
            await page.click('#passkey-login');await page.locator(entryCard).first().waitFor({state:'visible'});
            assert.equal(await page.evaluate(()=>window.loginMetrics.vaultDecrypts),2,'retry must use a new ceremony and clear the failed attempt');
          }
        }
      }
      assert.equal(await page.evaluate(()=>window.loginAuthentication.prfOutput.every(value=>value===0)&&window.loginAuthentication.diaryPreparedKeys===null&&window.loginAuthentication.diaryPrivateKeys===null),true);
      assert.deepEqual(errors,[]);
      console.log(`Login pipeline ${scenario}: passed.`);
    }catch(error){console.error(JSON.stringify({scenario,view:await page.evaluate(()=>({login:document.querySelector('#login-message')?.textContent,status:document.querySelector('#diary-search-status')?.textContent,entries:document.querySelector('#entry-list')?.textContent,metrics:window.loginMetrics}))}));throw error;}
    finally{release();f.user.active=true;await context.close();}
  }

  for(const reopen of [false,true]){
    const context=await browser.newContext(devices['Pixel 7']);await f.configure(context);
    const releaseFirst=Promise.withResolvers(),releaseFinal=Promise.withResolvers();
    let page=await context.newPage();
    try {
      await page.goto(f.origin+'/diary/');
      await page.locator('#passkey-login').click();
      await page.locator(entryCard).first().waitFor({state:'visible'});
      const cacheKey=await page.evaluate(async()=>{
        const {profile}=await (await fetch('/diary/api/encryption/profile')).json();
        return [profile.actor.accountId,profile.actor.credentialId,profile.household,profile.directory.value.generation].join('/');
      });
      await page.waitForFunction(async key=>{
        const {openCipherCache}=await import('/diary/crypto/e2ee/cache.mjs');
        const store=await openCipherCache();
        try{return Boolean(await store.getIndex(key));}
        finally{store.close();}
      },cacheKey,{polling:150});
      await page.locator('#logout-button').click();
      await page.locator('#passkey-login').waitFor({state:'visible'});
      if(reopen){await page.close();page=await context.newPage();await page.goto(f.origin+'/diary/');}
      await page.locator('#passkey-login').waitFor({state:'visible'});
      await page.evaluate(()=>{window.loginMetrics={vaultDecrypts:0,requests:[]};});
      let checks=0;
      await page.route('**/diary/api/session',async route=>{
        const step=++checks;
        if(step===3)await releaseFirst.promise;
        if(step===4)await releaseFinal.promise;
        await route.continue();
      });
      const waitForCheck=step=>page.waitForFunction(step=>window.loginMetrics.requests.filter(path=>path==='/diary/api/session').length>=step,step);
      const delta=page.waitForResponse(response=>{
        const url=new URL(response.url());
        return url.pathname==='/diary/api/encryption/snapshot'&&Number(url.searchParams.get('since'))>=0&&response.ok();
      });
      await Promise.all([page.locator('#passkey-login').click(),waitForCheck(3),delta]);
      assert.equal(await page.locator(entryCard).count(),0,'the delta arrived while the first check was held');
      releaseFirst.resolve();
      await waitForCheck(4);
      assert.equal(await page.locator(entryCard).count(),0,'the result is withheld until the final live check');
      releaseFinal.resolve();
      await page.locator(entryCard).first().waitFor({state:'visible'});
      const metrics=await page.evaluate(()=>window.loginMetrics);
      assert.equal(checks,4);
      assert.equal(metrics.requests.filter(path=>path===profilePath).length,1);
      assert.equal(metrics.requests.includes('/diary/api/encryption/prepare'),false);
      assert.equal(metrics.requests.includes('/diary/api/encryption/head'),false);
      assert.equal(metrics.vaultDecrypts,1);
      console.log(`Cached re-login (${reopen?'reopened tab':'same tab'}): delta overlap and both display gates passed.`);
    }finally{releaseFirst.resolve();releaseFinal.resolve();await context.close();}
  }
  console.log('Android-emulated login pipeline passed.');
}finally{await browser.close();await f.close();}
