import assert from 'node:assert/strict';

export async function verifySessionClearing(browser,url){
 const context=await browser.newContext();
 try{
  async function open(){const page=await context.newPage();await page.goto(url+'#accounts');await page.locator('#app-view').waitFor({state:'visible'});return page;}
  async function cleared(page){await page.locator('#login-view').waitFor({state:'visible'});assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#accounts .account-card,#entries tr,#chart svg').count(),0);assert.equal(await page.locator('#account-name').textContent(),'');assert.equal(await page.locator('#restore-file').inputValue(),'');assert.equal(await page.locator('#account-items').textContent(),'');assert.equal(await page.locator('#account-form [name=name]').inputValue(),'');assert.ok(!(await page.locator('body').textContent()).includes('SECRET-UNSAVED'));
   await page.goBack();assert.equal(await page.locator('#app-view').isVisible(),false);
  }
  for(const status of [401,403]){const page=await open();await page.locator('.account-card').first().getByRole('button',{name:'編集',exact:true}).click();await page.locator('#account-form [name=name]').fill('SECRET-UNSAVED');await page.route('**/household/api/mutate',r=>r.fulfill({status,body:'invalid JSON'}));await page.locator('#account-form [type=submit]').click();await cleared(page);await page.close();}
  {const page=await open();await page.locator('[data-view=settings]').click();await page.locator('#restore-file').setInputFiles({name:'secret.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({format:'troom-household',version:1,data:{accounts:[],transactions:[],categories:[],snapshots:[],historical:[]}}))});await page.route('**/household/api/backup',r=>r.fulfill({status:401,body:'expired'}));await page.locator('#export-backup').click();await cleared(page);await page.close();}
  {const page=await open();let release,started;const ready=new Promise(r=>started=r),wait=new Promise(r=>release=r);await page.route('**/household/api/data',async route=>{const response=await route.fetch();started();await wait;await route.fulfill({response}).catch(()=>{});});await page.locator('#refresh').click();await ready;await page.evaluate(()=>dispatchEvent(new Event('troom-session-expired')));release();await cleared(page);await page.waitForTimeout(100);assert.equal(await page.locator('#app-view').isVisible(),false);await page.close();}
  {const page=await open(),other=await open();await page.evaluate(()=>{const ch=new BroadcastChannel('household-ledger');ch.postMessage('session-changed');ch.close();});await cleared(other);await other.close();await page.close();}
  {const page=await open();await page.route('**/household/api/logout',r=>r.abort());await page.locator('#logout').click();await cleared(page);await page.close();}
  {const expiryContext=await browser.newContext(),page=await expiryContext.newPage(),started=Date.now(),expiresAt=(started+3600000)/1000;let calls=0;
   try{
    // Loading the authenticated view must finish before expiry is exercised;
    // a one-second wall-clock TTL can expire during slow WebKit startup.
    await page.clock.install({time:started});
    await page.route('**/household/api/session',async r=>{const value=await (await r.fetch()).json();await r.fulfill({status:++calls===1?200:401,contentType:'application/json',body:JSON.stringify(calls===1?{...value,expiresAt}:{error:'expired'})});});
    await page.goto(url);await page.locator('#app-view').waitFor({state:'visible'});await page.locator('.account-card').first().waitFor({state:'attached'});
    await page.clock.pauseAt(started+3601000);await cleared(page);
   }finally{await expiryContext.close();}
  }
  {const page=await context.newPage();let calls=0;await page.route('**/household/api/session',async r=>{calls++;const value=await (await r.fetch()).json();return r.fulfill({contentType:'application/json',body:JSON.stringify({...value,expiresAt:Date.now()/1000+30*86400})});});await page.goto(url);await page.locator('#app-view').waitFor({state:'visible'});await page.waitForTimeout(100);assert.equal(calls,1,'Long TTL must not overflow setTimeout into a request loop');await page.close();}
  console.log('Session clearing: malformed 401, 403, unsaved form, downloads, late response, cross-tab, offline logout, expiry and Back passed.');
 }finally{await context.close();}
}
