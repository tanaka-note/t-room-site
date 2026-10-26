import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';

const fixture=await startUIFixture();
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const traverse=(page,direction)=>page.evaluate(direction=>new Promise(resolve=>{
  window.addEventListener('popstate',resolve,{once:true});history[direction]();
}),direction);
try {for(const [name,engine,launch] of engines) {
  const browser=await engine.launch({headless:true,...launch});
  try {for(const standalone of [false,true]) {
    const context=await browser.newContext({viewport:standalone?{width:390,height:844}:{width:1280,height:800},hasTouch:true});
    if(standalone){await context.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));await context.addCookies([{name:'standalone',value:'1',url:fixture.origin}]);}
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    let block=false,blockForward=false,blockFresh=false,status=200,waiting=[];
    await page.route('**/cloud/api/**',async route=>{
      const url=new URL(route.request().url());if(!url.pathname.endsWith('/items')){await route.fulfill({json:{}});return;}
      const folder=Number(url.searchParams.get('folderId'));
      if(block&&(folder===8||(blockForward&&folder===9)||(blockFresh&&folder===7)))await new Promise(resolve=>waiting.push(resolve));
      await route.fulfill({status:folder===8?status:200,json:folder===8&&status!==200?{error:'Synthetic access denial'}:{
        folder:{fileCount:0,folderCount:32},folders:Array.from({length:32},(_,i)=>({id:folder*100+i,name:`Synthetic ${folder}/${i}`,cryptoVersion:0,isUnlocked:true})),
        files:[],breadcrumbs:[{id:folder,name:`Folder ${folder}`,cryptoVersion:0}],nextFolderOffset:null,nextFileOffset:null
      }}).catch(()=>{});
    });
    try {
      await preparePage(page,fixture.origin,0);
      await page.evaluate(async()=>{
        globalThis.TCloudDisplayCache={...TCloudDisplayCache,supported:()=>false};
        await navigateToFolder(7,'A');await navigateToFolder(8,'B');__test.scrollAppTo({top:600,behavior:'auto'});
      });await frames(page);
      const position=await page.evaluate(()=>__test.appScrollPosition().y);
      assert.ok(position>0,'test a meaningful saved scroll position');
      await page.evaluate(async()=>{await navigateToFolder(9,'C');__test.scrollAppTo({top:500,behavior:'auto'});});await frames(page);
      await page.evaluate(()=>{
        globalThis.__historyPaints=[];globalThis.__historySampling=true;
        const visible=element=>{if(!element)return false;for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0)return false;}return true;};
        const sample=()=>{if(!__historySampling)return;__historyPaints.push({target:__test.state.folderId,busy:document.querySelector('.workspace').inert,
          title:document.querySelector('#view-title').textContent,titleVisible:visible(document.querySelector('#view-title')),
          cardVisible:visible(document.querySelector('.folder-card')),floatingVisible:visible(document.querySelector('#floating-toolbar')),
          loading:visible(document.querySelector('#folder-navigation-loading')),position:__test.appScrollPosition().y});requestAnimationFrame(sample);};sample();
      });
      const ready=()=>page.waitForFunction(()=>!document.querySelector('.workspace').inert);
      const release=()=>{for(const resolve of waiting)resolve();waiting=[];};
      block=true;await traverse(page,'back');
      await page.waitForFunction(()=>__test.state.folderId===8&&document.querySelector('.workspace').inert);
      await frames(page);await page.waitForTimeout(100);
      const pending=await page.evaluate(()=>__historyPaints.filter(frame=>frame.target===8&&frame.busy));
      assert.ok(pending.length>2);
      assert.ok(pending.every(frame=>!frame.titleVisible&&!frame.cardVisible&&!frame.floatingVisible&&frame.loading),'the source must never paint after a confirmed history traversal');
      const loader=await page.locator('#folder-navigation-loading').boundingBox();
      assert.ok(loader&&loader.x>=0&&loader.y>=0&&loader.x+loader.width<=(standalone?390:1280),'loading status stays in the viewport');
      assert.equal(await page.locator('#folder-navigation-loading').getAttribute('role'),'status');
      if(process.env.TROOM_HISTORY_SCREENSHOTS&&name==='chromium')await page.screenshot({path:`tmp/history-loading-${standalone?'pwa':'desktop'}.png`});
      release();block=false;await ready();await frames(page);
      const restored=await page.evaluate(()=>__historyPaints.filter(frame=>frame.target===8&&!frame.busy));
      assert.ok(restored.length&&restored.every(frame=>frame.title==='B'&&frame.titleVisible&&frame.cardVisible&&!frame.loading&&Math.abs(frame.position-position)<=2),'only the completed destination and restored position become visible');

      // A new traversal owns the mask; the old response cannot remove it or overwrite the page.
      await traverse(page,'forward');await ready();block=true;await traverse(page,'back');
      await page.waitForFunction(()=>document.querySelector('.workspace').inert);
      blockForward=true;await traverse(page,'forward');
      await page.waitForFunction(()=>__test.state.folderId===9&&document.querySelector('.workspace').inert);await frames(page);
      assert.equal(await page.locator('#folder-navigation-loading').isVisible(),true,'old cancellation must not reveal a newer pending destination');
      assert.equal(await page.locator('.folder-card').first().isVisible(),false);
      release();block=false;blockForward=false;await ready();await frames(page);
      assert.equal(await page.locator('#view-title').innerText(),'C');
      assert.equal(await page.locator('#folder-navigation-loading').isVisible(),false);

      // A rejected destination must remove the mask and must not reveal old content.
      status=403;await traverse(page,'back');await ready();await frames(page);
      assert.equal(await page.locator('.folder-card').count(),0);
      assert.equal(await page.locator('#folder-navigation-loading').isVisible(),false);
      assert.equal(await page.locator('.workspace').evaluate(el=>el.classList.contains('is-history-loading')),false);
      status=200;await traverse(page,'forward');await ready();
      block=true;await traverse(page,'back');await page.waitForFunction(()=>document.querySelector('.workspace').inert);
      blockFresh=true;await page.evaluate(()=>{void navigateToFolder(7,'A');});
      await page.waitForFunction(()=>__test.state.folderId===7&&document.querySelector('.workspace').inert);await frames(page);
      assert.equal(await page.locator('#folder-navigation-loading').isVisible(),true,'a normal navigation interrupting Back keeps the source masked');
      assert.equal(await page.locator('.folder-card').first().isVisible(),false);
      release();block=false;blockFresh=false;await ready();
      assert.equal(await page.locator('#view-title').innerText(),'A');
      assert.equal(await page.locator('#folder-navigation-loading').isVisible(),false);
      block=true;await traverse(page,'back');await page.waitForFunction(()=>document.querySelector('.workspace').inert);
      await page.evaluate(()=>__test.releaseSessionState());release();block=false;await frames(page);
      assert.equal(await page.locator('#folder-navigation-loading').isVisible(),false,'logout removes the loading state');
      assert.equal(await page.locator('.folder-card').count(),0);
      await page.evaluate(()=>{__historySampling=false;});assert.deepEqual(errors,[]);
      console.log('PASS history loading',name,{standalone,sourcePaints:0,restoredPosition:position,interruption:true,denial:true,logout:true});
    } finally {for(const resolve of waiting)resolve();await context.close();}
  }} finally {await browser.close();}
}} finally {await fixture.close();}
