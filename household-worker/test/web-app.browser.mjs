import assert from 'node:assert/strict';

export async function verifyWebApp(browser,url){
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(url);await page.locator('#app-view').waitFor({state:'visible'});
  assert.equal(await page.locator('#install-app').isVisible(),false);
  await page.locator('[data-view=settings]').click();await page.locator('#install-app').waitFor({state:'visible'});
  assert.equal(await page.locator('#install-app').evaluate(n=>n.closest('#view-settings')!==null),true);
  const cdp=await context.newCDPSession(page);const result=await cdp.send('Page.getAppManifest');
  assert.deepEqual(result.errors,[]);const manifest=JSON.parse(result.data);assert.equal(manifest.display,'standalone');assert.equal(manifest.scope,'/household/');
  for(const icon of manifest.icons){const image=await page.evaluate(async src=>{const i=new Image();i.src=src;await i.decode();return [i.naturalWidth,i.naturalHeight];},new URL(icon.src,result.url).href);assert.deepEqual(image,icon.sizes.split('x').map(Number));}
  const installability=await cdp.send('Page.getInstallabilityErrors');assert.deepEqual(installability.installabilityErrors,[]);
  assert.equal(await page.evaluate(async()=> (await navigator.serviceWorker.getRegistrations()).length),0);
  await page.locator('#install-app').click();assert.match(await page.locator('#install-help').textContent(),/アプリをインストール/);
  // A real browser event is supplied by the OS. Synthetic events test our one-use handler and its lifecycle.
  async function prompt(outcome){
   await page.evaluate(()=>{window.promptCalls=0;const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>{window.promptCalls++;};event.userChoice=new Promise(resolve=>{window.resolveInstallChoice=resolve;});window.installPrevented=!dispatchEvent(event);});
   assert.equal(await page.evaluate(()=>window.installPrevented),true);
   await page.locator('#install-app').click();assert.equal(await page.locator('#install-app').isDisabled(),true);assert.equal(await page.locator('body').getAttribute('data-troom-update-block'),'true');
   await page.evaluate(outcome=>window.resolveInstallChoice({outcome}),outcome);await page.waitForFunction(()=>!document.querySelector('#install-app').disabled);
   assert.equal(await page.evaluate(()=>window.promptCalls),1);assert.equal(await page.locator('body').getAttribute('data-troom-update-block'),'false');
  }
  await prompt('dismissed');assert.equal(await page.locator('#install-app').isVisible(),true);
  await page.locator('#install-app').click();assert.equal(await page.evaluate(()=>window.promptCalls),1);
  await page.evaluate(()=>{const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>{throw Error('synthetic failure');};dispatchEvent(event);});await page.locator('#install-app').click();await page.waitForFunction(()=>document.querySelector('#install-help').textContent.startsWith('追加画面を開けませんでした'));
  await prompt('accepted');assert.match(await page.locator('#install-help').textContent(),/受け付けました/);
  await page.evaluate(()=>dispatchEvent(new Event('appinstalled')));assert.equal(await page.locator('#install-app').isVisible(),false);assert.match(await page.locator('#install-help').textContent(),/ウェブアプリとして利用/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await context.close();}
 for(const [platform,ua,touch]of [['iPhone','Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Version/26.0 Mobile/15E148 Safari/604.1',true],['iPad','Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/26.0 Safari/605.1.15',true],['Android','Mozilla/5.0 (Linux; Android 16) Chrome/144.0 Mobile Safari/537.36',true]]){
  const ctx=await browser.newContext({userAgent:ua,hasTouch:touch,viewport:{width:320,height:844}}),p=await ctx.newPage();
  try{
   if(platform==='iPad')await p.addInitScript(()=>{Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});});
   await p.goto(url+'#settings');await p.locator('#install-app').waitFor({state:'visible'});await p.locator('#install-app').click();assert.match(await p.locator('#install-help').textContent(),platform==='Android'?/Chrome/:/Safariの共有/);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await ctx.close();}
 }
 for(const mode of ['standalone','ios']){
  const ctx=await browser.newContext(),p=await ctx.newPage();try{
   await p.addInitScript(mode=>{if(mode==='ios')Object.defineProperty(navigator,'standalone',{get:()=>true});else{const original=window.matchMedia.bind(window);window.matchMedia=query=>{const result=original(query);if(query==='(display-mode: standalone)')Object.defineProperty(result,'matches',{get:()=>true});return result;};}},mode);
   await p.goto(url+'#settings');await p.locator('#app-view').waitFor({state:'visible'});assert.equal(await p.locator('#install-app').isVisible(),false);assert.match(await p.locator('#install-help').textContent(),/ウェブアプリとして利用/);
  }finally{await ctx.close();}
 }
 console.log('Household web app: Chromium installability, manifest/icons, settings-only entry, accepted/dismissed/failure prompts, update blocker, iPhone/iPad/Android help and standalone states passed.');
}
