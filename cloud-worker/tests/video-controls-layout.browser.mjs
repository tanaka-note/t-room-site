import assert from 'node:assert/strict';
import {engines,startUIFixture,preparePage} from './ui-fixture.mjs';
const reproduce=process.argv.includes('--reproduce'),fixture=await startUIFixture();
try {for(const [name,engine,launch] of engines){
 const browser=await engine.launch({headless:true,...launch});
 try {
  const page=await browser.newPage();await preparePage(page,fixture.origin,4);
  await page.route('**/cloud/api/**',route=>route.fulfill({json:{ok:true}}));
  await page.evaluate(()=>__test.unavailableVideo());
  for(const width of (process.argv.includes('--icon-probe')?[320]:[320,360,390,430,768,1280])){
   await page.setViewportSize({width,height:740});
   await page.evaluate(()=>__test.openPreview(__test.state.files[1]));
   // Simulate using the sticky actions after scrolling away from the video.
   await page.evaluate(()=>{const d=document.querySelector('#preview-dialog');d.scrollTop=d.scrollHeight;});
   await page.locator('#preview-more summary').click();
   await page.locator('#manual-thumbnail-button').click();
   await page.locator('.preview-player-time').evaluate(e=>e.textContent='1:03:42 / 2:45:59');
   const layout=await page.evaluate(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    const controls=document.querySelector('.preview-player-controls'),panel=document.querySelector('.manual-thumbnail-panel');
    const style=getComputedStyle(panel);
    return {width:innerWidth,controls:rect(controls),parts:[...controls.children].map(rect),panel:rect(panel),scroll:document.querySelector('#preview-dialog').scrollTop,bg:style.backgroundColor,color:style.color,repeatFill:getComputedStyle(controls.querySelector('.preview-player-mode svg')).fill,actions:rect(document.querySelector('.preview-actions'))};
   });
   console.log(JSON.stringify({name,width,...layout}));
   if(!reproduce){
    assert.ok(layout.controls.right<=width+1 && layout.controls.x>=-1);
    assert.ok(layout.parts[2].w>=100,'usable seek width');
    for(let i=0;i<layout.parts.length;i++)for(let j=i+1;j<layout.parts.length;j++){
     const a=layout.parts[i],b=layout.parts[j];assert.ok(a.right<=b.x+1||b.right<=a.x+1||a.bottom<=b.y+1||b.bottom<=a.y+1,'controls must not overlap');
    }
    assert.ok(layout.panel.y>=0 && layout.panel.bottom<=740,'panel must enter viewport');
    assert.notEqual(layout.bg,'rgba(0, 0, 0, 0)');
    assert.equal(layout.repeatFill,'none','outline icon must not be filled');
    if(width<=600)assert.ok(layout.panel.bottom<=layout.actions.y,'sticky actions must not cover the editor');
    for(const i of [3,4,5])assert.ok(layout.parts[i].w>=34 && layout.parts[i].h>=34);
   }
   await page.locator('[data-action="cancel"]').click();
   const repeat=page.locator('.preview-player-mode');
   await repeat.click();
   assert.equal(await repeat.getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator('#preview-stage video').evaluate(v=>v.loop),true);
   assert.ok(await repeat.evaluate(b=>b.classList.contains('is-active') && b.title==='動画リピート' && b.getAttribute('aria-label')===b.title));
   await repeat.click();
   assert.equal(await repeat.getAttribute('aria-pressed'),'false');
   assert.equal(await page.locator('#preview-stage video').evaluate(v=>v.loop),false);
   // Standalone/mobile safe-area equivalent: reserve space on both edges.
   if(width<=430){
    const safe=await page.locator('.preview-player-controls').evaluate(c=>{
     c.style.paddingLeft='20px';c.style.paddingRight='20px';
     const r=c.getBoundingClientRect();return [...c.children].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left && b.right<=r.right;});
    });
    assert.ok(safe,'safe-area controls stay inside their container');
   }
  }
  if(name==='chromium'){
   await page.locator('.preview-player-fullscreen').click();
   await page.waitForFunction(()=>!!document.fullscreenElement);
   assert.ok(await page.locator('.preview-player-controls').evaluate(c=>{const r=c.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));
   await page.evaluate(()=>document.exitFullscreen());
  }
 }finally{await browser.close();}
}}finally{await fixture.close();}
