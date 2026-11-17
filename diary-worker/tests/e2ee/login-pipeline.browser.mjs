import assert from 'node:assert/strict';
import {chromium,devices} from 'playwright';
import {loginStartupFixture} from './login-startup-fixture.mjs';

const f=await loginStartupFixture(),browser=await chromium.launch({headless:true});
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
        await page.route('**/diary/api/encryption/profile',async route=>{
          const response=await route.fetch(),value=await response.json();
          value.profile.vault.privateEnvelope.ciphertext=value.profile.vault.privateEnvelope.ciphertext.replace(/^./,c=>c==='A'?'B':'A');
          await route.fulfill({response,json:value});
        });
        await page.click('#passkey-login');
        await page.waitForFunction(()=>!document.querySelector('#passkey-login').disabled&&window.loginAuthentication?.prfOutput.every(value=>value===0));
        assert.equal(await page.locator('#app-view').isVisible(),false);
        assert.equal(await page.evaluate(()=>window.loginMetrics.vaultDecrypts),2,'a changed vault cannot reuse the old private keys and goes through fresh decryption');
      }else {
        let held,assetFailed;
        const holding=new Promise(resolve=>{held=resolve;}),gate=new Promise(resolve=>{release=resolve;});
        await page.route('**/diary/api/encryption/prepare',async route=>{held();await gate;await route.continue();});
        const failed=new Promise(resolve=>{assetFailed=resolve;});
        if(scenario==='asset-retry')await page.route('**/dialog-navigation.js?*',async route=>{await route.fulfill({status:503,body:'Synthetic asset failure'});assetFailed();});
        const imported=page.waitForRequest(request=>new URL(request.url()).pathname==='/diary/diary.js');
        await page.click('#passkey-login');await holding;await imported;
        assert.equal(await page.locator('#app-view').isVisible(),false,'loading modules must not expose the app before preparation');
        assert.equal(f.wire.slice(before).some(row=>row.path==='/diary/api/encryption/profile'),false);
        if(scenario==='asset-retry')await failed;
        assert.equal(await page.evaluate(()=>window.loginAuthentication.prfOutput.some(value=>value!==0)),true,'an early asset error must not clear PRF while preparation is still using it');
        if(scenario==='revoked')f.user.active=false;
        release();
        if(scenario==='parallel') {
          await page.locator('#entry-list .diary-entry-card').first().waitFor({state:'visible'});
          const metrics=await page.evaluate(()=>window.loginMetrics),start=metrics.requests.indexOf('/diary/api/passkey/handoff');
          assert.equal(metrics.vaultDecrypts,1,'one vault decryption for preparation and application startup combined');
          assert.equal(metrics.requests.slice(start+1).filter(path=>path==='/diary/api/session').length,4,'both live checks for unlock and for initial snapshot remain');
        }else {
          await page.waitForFunction(()=>!document.querySelector('#passkey-login').disabled&&document.querySelector('#login-message').textContent);
          assert.equal(await page.locator('#app-view').isVisible(),false);
          assert.equal(f.wire.slice(before).some(row=>row.path==='/diary/api/encryption/profile'),false);
          assert.equal(await page.evaluate(()=>window.loginAuthentication.diaryPreparedKeys),null);
          if(scenario==='asset-retry') {
            assert.equal(await page.evaluate(()=>window.loginAuthentication.prfOutput.every(value=>value===0)),true);
            await page.unroute('**/dialog-navigation.js?*');await page.unroute('**/diary/api/encryption/prepare');
            await page.click('#passkey-login');await page.locator('#entry-list .diary-entry-card').first().waitFor({state:'visible'});
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
  console.log('Android-emulated login pipeline: gated parallel module loading, single bound vault unlock, unchanged live checks, asset failure/retry, changed vault and revocation passed.');
}finally{await browser.close();await f.close();}
