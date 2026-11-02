import assert from 'node:assert/strict';

// Use the shipped login handler and chooser. Only WebAuthn and server replies
// use synthetic fixtures; no device credential or production account is used.
export async function verifyPasskeyLogin(browser,url,state){
 const links=[
  {id:'original-link',accountId:'owner',displayLabel:'Synthetic original portfolio',roleLabel:'オーナー'},
  {id:'shared-link',accountId:'chiharu-admin',displayLabel:'Synthetic shared portfolio',roleLabel:'オーナー'}
 ];
 for(const mode of ['multiple','single','cancel','escape']){
  const context=await browser.newContext({viewport:{width:390,height:844}});
  try{
   const page=await context.newPage(),handoffs=[],sessions=[],errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{
    Object.defineProperty(window,'PublicKeyCredential',{configurable:true,value:class {}});
    Object.defineProperty(navigator,'credentials',{configurable:true,value:{
     get:async()=>({id:'AQI',rawId:new Uint8Array([1,2]).buffer,type:'public-key',response:{clientDataJSON:new Uint8Array([1]).buffer,authenticatorData:new Uint8Array([2]).buffer,signature:new Uint8Array([3]).buffer},getClientExtensionResults:()=>({})}),
     create:async()=>{throw new Error('Login must never register a credential');}
    }});
   });
   await page.route('**/security/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    let value;
    if(path.endsWith('/auth/options'))value={challengeId:'synthetic-challenge',options:{challenge:'AQI',rpId:'localhost',userVerification:'required'}};
    else if(path.endsWith('/auth/verify'))value={credentialId:'AQI',links:mode==='single'?[links[1]]:links};
    else if(path.endsWith('/auth/handoff')){handoffs.push(route.request().postDataJSON());value={handoffToken:'synthetic-handoff'};}
    else throw new Error(`Unexpected Security request: ${path}`);
    await route.fulfill({json:value});
   });
   await page.route('**/asset-report/api/session',r=>r.fulfill({status:401,json:{error:'パスキーでログインしてください。'}}));
   await page.route('**/asset-report/api/passkey/handoff',r=>{
    sessions.push(r.request().postDataJSON());
    return r.fulfill({json:{authenticated:true,displayName:links[1].displayLabel,role:'owner',sessionContext:'synthetic-session',expiresAt:Math.floor(Date.now()/1000)+43200}});
   });
   await page.route('**/asset-report/api/data',r=>r.fulfill({json:state}));
   await page.goto(url);await page.locator('#login-button').waitFor({state:'visible'});await page.waitForFunction(() => window.TRoomPasskeys);
   const button = page.locator('#login-button');
   assert.equal(await button.locator('.passkey-icon').count(), 1);
   assert.equal(await button.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(87, 114, 99)');
   await button.focus();
   assert.equal(await button.evaluate(el => getComputedStyle(el).outlineColor), 'rgb(140, 168, 149)');
   await button.click();
   if(mode!=='single'){
    const dialog=page.getByRole('dialog',{name:'利用するアカウントを選択'});await dialog.waitFor({state:'visible'});
    assert.deepEqual(await dialog.locator('strong').allTextContents(),links.map(l=>l.displayLabel));
    assert.deepEqual(handoffs,[]);assert.deepEqual(sessions,[]);
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#passkey-login-label').textContent(), '確認中…');
    if(mode==='multiple')await dialog.getByRole('button',{name:'Synthetic shared portfolio'}).click();
    else if(mode==='cancel')await dialog.getByRole('button',{name:'キャンセル',exact:true}).click();
    else await page.keyboard.press('Escape');
   }
   await page.waitForFunction(()=>document.querySelector('#passkey-login-label').textContent==='パスキーでログイン');
   assert.equal(await page.locator('.troom-passkey-account-dialog').count(),0);
   assert.equal(await button.locator('.passkey-icon').count(), 1);
   assert.equal(await button.getAttribute('aria-busy'), null);
   if(['multiple','single'].includes(mode)){
    await page.locator('#report-app').waitFor({state:'visible'});
    assert.deepEqual(handoffs,[{service:'portfolio',linkId:'shared-link'}]);
    assert.deepEqual(sessions,[{handoffToken:'synthetic-handoff'}]);
    assert.equal(await page.locator('#account-label').textContent(),links[1].displayLabel);
   }else{
    assert.deepEqual(handoffs,[]);assert.deepEqual(sessions,[]);
    assert.equal(await page.locator('#report-app').isVisible(),false);assert.equal(await page.locator('#login-button').isEnabled(),true);
   }
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 console.log('Passkey login: multiple accounts, single account, cancellation and Escape passed.');
}
