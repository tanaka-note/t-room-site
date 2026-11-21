import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
import {startDiaryPhotoFixture} from './photo-read-fixture.mjs';

const count=Number(process.env.DIARY_PHOTO_BENCH_TRIALS||7);
assert.ok(Number.isInteger(count)&&count>=3);
const optimized=process.argv.includes('--indexed');
const runs=[];
const summary=values=>{
  const ordered=[...values].sort((a,b)=>a-b);
  return {p50:ordered[Math.floor(ordered.length/2)],p95:ordered[Math.ceil(ordered.length*.95)-1]};
};
const fixture=await startDiaryPhotoFixture({indexed:optimized,background:true,responseDelay:true});
try {
  for(let trial=0;trial<count;trial++) {
    const {context,page}=await fixture.login({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const before=fixture.mediaRequests.length;
    const mark=()=>page.evaluate(()=>{window.photoBenchmarkStart=performance.now();});
    const elapsed=()=>page.evaluate(()=>Math.round(performance.now()-window.photoBenchmarkStart));
    const albumReady=selector=>page.waitForFunction(selector=>document.querySelector(selector)?.naturalWidth>0,
      selector,{polling:'raf'});
    const viewerReady=(file)=>page.waitForFunction(file=>
      document.querySelector('#photo-viewer-file').textContent.startsWith(file+' /')&&
      document.querySelector('#photo-viewer-status').hidden&&document.querySelector('#photo-viewer-image')?.naturalWidth>0,
      file,{polling:'raf'});
    try {
      await page.evaluate(()=>{window.photoBenchmarkStart=performance.now();document.querySelector('#camera-roll-button').click();});
      await albumReady('#camera-roll-grid img');
      const first=await elapsed();
      const target=page.locator('#camera-roll-grid [data-photo-index]').nth(22);
      await target.waitFor({state:'attached'});
      assert.ok(await target.evaluate(node=>node.getBoundingClientRect().top>innerHeight),'scroll target starts below the viewport');
      // Allow the same reading time before scrolling in both versions.
      await pause(500);
      await target.evaluate(node=>{window.photoBenchmarkStart=performance.now();node.scrollIntoView({block:'center',behavior:'instant'});});
      await albumReady('#camera-roll-grid [data-photo-index="22"] img');
      const scroll=await elapsed();
      const targetName=await target.locator('img').getAttribute('alt');
      await target.evaluate(node=>{window.photoBenchmarkStart=performance.now();node.click();});
      await viewerReady(targetName);
      const zoom=await elapsed();
      const neighborOffset=await page.locator('#camera-roll-grid [data-photo-index]').nth(23).locator('img').getAttribute('alt');
      await pause(350);
      await mark();await page.keyboard.press('ArrowRight');await viewerReady(neighborOffset);
      const next=await elapsed();
      await pause(350);
      await mark();await page.keyboard.press('ArrowLeft');await viewerReady(targetName);
      const previous=await elapsed();
      const requests=fixture.mediaRequests.slice(before);
      runs.push({first,scroll,zoom,next,previous,requests:requests.length,withBody:requests.filter(r=>r.status===200).length});
    } finally {await context.close();}
  }
  assert.deepEqual(fixture.errors,[]);
  console.log(JSON.stringify({optimized,unit:'ms',trials:runs,
    summary:Object.fromEntries(Object.keys(runs[0]).map(key=>[key,summary(runs.map(run=>run[key]))]))}));
} finally {await fixture.close();}
