import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Actual component/CSS and trusted Chromium touch events; no production data or API writes.
export async function verifyChartTouch(browser){
  const context=await browser.newContext({viewport:{width:320,height:844},isMobile:true,hasTouch:true});
  try{
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const css=readFileSync(new URL('../public/household.css',import.meta.url),'utf8');
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main><div class="chart-readout"><div><span id="month"></span><strong id="value"></strong></div><span id="change"></span></div><div id="chart" class="chart-plot" tabindex="0"></div><p id="outside">グラフの外でページをスクロール</p><span id="live" class="sr-only"></span><div style="height:1600px"></div></main>`);
    await page.addScriptTag({path:fileURLToPath(new URL('../public/asset-chart.js',import.meta.url))});
    await page.evaluate(()=>{
      window.samples=Array.from({length:53},(_,i)=>({month:TRoomAssetChart.monthAt(TRoomAssetChart.monthIndex('2022-06')+i),value:5000000+i*10000}));
      window.component=TRoomAssetChart.create({root:document.querySelector('#chart'),month:document.querySelector('#month'),value:document.querySelector('#value'),change:document.querySelector('#change'),live:document.querySelector('#live')});
      component.update(samples);
    });
    const frame=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await frame();
    const hit=await page.locator('.chart-hit').boundingBox(),cdp=await context.newCDPSession(page);
    const touch=(type,x=0,y=0)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:['touchEnd','touchCancel'].includes(type)?[]:[{x,y,id:1}]});
    await page.evaluate(()=>{
      window.metrics={cancels:0,moves:0,writes:0,reads:0};
      const root=document.querySelector('#chart'),svg=root.querySelector('svg'),original=svg.getBoundingClientRect.bind(svg);
      svg.getBoundingClientRect=()=>{metrics.reads++;return original();};
      root.addEventListener('pointercancel',()=>metrics.cancels++);
      root.addEventListener('pointermove',event=>{if(event.pointerType==='touch')metrics.moves++;});
      new MutationObserver(records=>metrics.writes+=records.length).observe(document.querySelector('#value'),{childList:true});
    });
    const scrollBefore=await page.evaluate(()=>scrollY);
    await touch('touchStart',hit.x+1,hit.y+15);
    // Deliberately steep initial movement reproduced the old pan-y cancellation.
    await touch('touchMove',hit.x+5,hit.y+85);
    for(let i=1;i<=18;i++)await touch('touchMove',hit.x+1+(hit.width-2)*i/18,hit.y+hit.height*(.5+.3*Math.sin(i)));
    await touch('touchEnd');await frame();
    const metrics=await page.evaluate(()=>({...window.metrics,scroll:scrollY,month:document.querySelector('#month').textContent,touchAction:getComputedStyle(document.querySelector('#chart')).touchAction}));
    assert.equal(metrics.cancels,0,JSON.stringify(metrics));assert.ok(metrics.moves>3);assert.ok(metrics.writes>1);assert.ok(metrics.reads<=3);
    assert.equal(metrics.scroll,scrollBefore);assert.equal(metrics.month,'2026年10月末');assert.ok(metrics.touchAction.includes('pinch-zoom'));

    // A cancelled touch restores the previously selected month and discards its queued frame.
    await touch('touchStart',hit.x+10,hit.y+20);await touch('touchMove',hit.x+hit.width*.4,hit.y+30);await touch('touchCancel');await frame();
    assert.equal(await page.locator('#month').textContent(),'2026年10月末');

    // Burst input may paint once per frame, not once per raw event or repeatedly for the same month.
    const burst=await page.evaluate(async()=>{
      const overlay=document.querySelector('.chart-hit'),box=overlay.getBoundingClientRect(),value=document.querySelector('#value');let writes=0;
      const observer=new MutationObserver(records=>writes+=records.length);observer.observe(value,{childList:true});
      const move=fraction=>overlay.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',pointerId:9,clientX:box.left+box.width*fraction,bubbles:true}));
      overlay.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));
      for(let i=0;i<200;i++)move(i%2?.1:.4);move(.4);
      const beforeFrame=observer.takeRecords().length;
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      writes+=observer.takeRecords().length;const afterFrame=writes;
      for(let i=0;i<200;i++)move(.4);
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      writes+=observer.takeRecords().length;observer.disconnect();
      // Leaving before a queued frame must not restore a stale hover later.
      move(.1);overlay.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      await new Promise(done=>requestAnimationFrame(done));
      return {beforeFrame,afterFrame,afterSameMonth:writes,month:document.querySelector('#month').textContent};
    });
    assert.equal(burst.beforeFrame,0);assert.equal(burst.afterFrame,1);assert.equal(burst.afterSameMonth,1);assert.equal(burst.month,'2026年10月末');
    await page.evaluate(()=>{
      const overlay=document.querySelector('.chart-hit'),box=overlay.getBoundingClientRect();
      overlay.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',pointerId:9,clientX:box.left+box.width*.3,bubbles:true}));
      component.update(samples.slice(-13),samples,'12');
    });await frame();assert.equal(await page.locator('#month').textContent(),'2026年10月末');
    await page.evaluate(()=>{
      const overlay=document.querySelector('.chart-hit'),box=overlay.getBoundingClientRect();
      overlay.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',pointerId:9,clientX:box.left+10,bubbles:true}));
      component.update([]);
    });await frame();assert.equal(await page.locator('#value').textContent(),'—');assert.equal(await page.locator('#chart svg').count(),0);

    await page.evaluate(()=>component.update(samples));await frame();
    const outside=await page.locator('#outside').boundingBox();
    await touch('touchStart',outside.x+outside.width/2,outside.y+10);
    for(let i=1;i<=8;i++)await touch('touchMove',outside.x+outside.width/2,outside.y+10-i*10);
    await touch('touchEnd');await page.waitForFunction(()=>scrollY>0);
    assert.deepEqual(errors,[]);
    console.log('Chart touch: native diagonal swipe stays captured, cached geometry, one paint per frame, duplicate-month suppression, cancellation, stale-frame clearing and outside scrolling passed.');
  }finally{await context.close();}
}
