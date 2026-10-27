import assert from "node:assert/strict";
import { engines, startUIFixture, preparePage } from "./ui-fixture.mjs";

const fixture = await startUIFixture();
try {
  for (const [name, engine, launch] of engines) {
    for (const pwa of [false,true]) {
      const browser = await engine.launch({headless:true,...launch});
      try {
        const context = await browser.newContext({viewport:pwa?{width:390,height:740}:{width:1440,height:900},hasTouch:pwa});
        if (pwa) {
          await context.addInitScript(() => Object.defineProperty(navigator,"standalone",{value:true}));
          await context.addCookies([{name:"standalone",value:"1",url:fixture.origin}]);
        }
        const page = await context.newPage(), errors = [], network = [];
        page.on("pageerror",e=>errors.push(e.message));
        const count = pwa ? 120 : 500;
        await preparePage(page,fixture.origin,count);
        await page.evaluate(() => {
          __test.photoFixture();
          __test.state.files.forEach(f=>{f.mediaKind="image";f.mimeType="image/png";f.hasThumbnail=false;});
          __test.renderItems();
          const stats = globalThis.__photoResources = {urls:0,maxUrls:0,listeners:0,maxListeners:0,observers:0,maxObservers:0,renders:0,created:0,revoked:0,historyReplacements:0};
          const replace = history.replaceState.bind(history);
          history.replaceState = (...args) => { stats.historyReplacements++;try { return replace(...args); } catch(error) { stats.historyError = error.name + ": " + error.message; throw error; } };
          const urls = new Set(), create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
          URL.createObjectURL = blob => { const url=create(blob);urls.add(url);stats.created++;stats.urls=urls.size;stats.maxUrls=Math.max(stats.maxUrls,urls.size);return url; };
          URL.revokeObjectURL = url => { if(urls.delete(url))stats.revoked++;stats.urls=urls.size;return revoke(url); };
          const stage = document.querySelector("#preview-stage"), add = stage.addEventListener.bind(stage);
          stage.addEventListener = (type,listener,options) => {
            if(options?.signal){stats.listeners++;stats.maxListeners=Math.max(stats.maxListeners,stats.listeners);options.signal.addEventListener("abort",()=>stats.listeners--,{once:true});}
            return add(type,listener,options);
          };
          const OriginalObserver = ResizeObserver;
          globalThis.ResizeObserver = class extends OriginalObserver {
            constructor(callback){super(callback);this.active=true;stats.observers++;stats.maxObservers=Math.max(stats.maxObservers,stats.observers);}
            disconnect(){if(this.active){this.active=false;stats.observers--;}return super.disconnect();}
          };
          const mutations = new MutationObserver(records=>{stats.renders+=records.filter(r=>r.type==="childList").length;});
          mutations.observe(stage,{childList:true});
          globalThis.__stopPhotoMutations = () => mutations.disconnect();
        });
        const start = pwa ? 0 : 99;
        await page.locator(`.file-card[data-file-id="${start+1}"]`).scrollIntoViewIfNeeded();
        const origin = await page.evaluate(() => __test.appScrollPosition().y);
        page.on("request",r=>{if(r.url().includes("/cloud/api/"))network.push(r.url());});
        const cdp = name === "chromium" ? await context.newCDPSession(page) : null;
        if(cdp)await cdp.send("HeapProfiler.collectGarbage");
        const before = cdp ? (await cdp.send("Runtime.getHeapUsage")).usedSize : null;
        const result = await page.evaluate(async ({start,count}) => {
          const stage = document.querySelector("#preview-stage");
          const loaded = () => new Promise((resolve,reject)=>{
            const ready=()=>Boolean(stage.querySelector("img")?.naturalWidth);
            if(ready()){resolve();return;}
            const timer=setTimeout(()=>{observer.disconnect();reject(new Error("photo load timed out"));},3000);
            const observer=new MutationObserver(()=>{if(ready()){clearTimeout(timer);observer.disconnect();resolve();}});
            observer.observe(stage,{childList:true});
          });
          await __test.openPreview(__test.state.files[start]); await loaded();
          let viewed=1;
          for(let i=start+1;i<count;i++){
            document.querySelector("#preview-next").click();await loaded();viewed++;
            if(__test.state.previewFileId!==i+1)throw new Error(JSON.stringify({expected:i+1,actual:__test.state.previewFileId,historyError:__photoResources.historyError,disabled:document.querySelector("#preview-next").disabled,previewClosePending:__test.state.previewClosePending}));
          }
          const backCount = Math.min(100,count-1);
          for(let i=0;i<backCount;i++){
            document.querySelector("#preview-prev").click();await loaded();viewed++;
          }
          return {viewed,lastId:__test.state.previewFileId,resources:{...__photoResources},cards:document.querySelectorAll(".file-card").length};
        },{start,count}).catch(error=>{console.error("Photo lifecycle page errors",errors);throw error;});
        assert.ok(result.viewed>=100);
        assert.ok(result.resources.maxUrls<=1,JSON.stringify(result));
        assert.equal(result.resources.maxListeners,8,"one photo viewer owns its pointer, double-click, wheel and drag listeners");
        assert.equal(result.resources.maxObservers,1);
        assert.ok(result.resources.historyReplacements<=2,JSON.stringify(result));
        assert.ok(result.resources.renders<=result.viewed*5+5,JSON.stringify(result));
        await page.locator("#preview-close").click();
        await page.waitForFunction(()=>__test.state.previewFileId===null&&!__test.state.previewClosePending);
        await page.waitForTimeout(80);
        const final = await page.evaluate(()=>{__stopPhotoMutations();return {resources:{...__photoResources},position:__test.appScrollPosition().y,cards:document.querySelectorAll(".file-card").length};});
        assert.equal(final.resources.urls,0);assert.equal(final.resources.created,final.resources.revoked);
        assert.equal(final.resources.listeners,0);assert.equal(final.resources.observers,0);
        assert.equal(final.cards,result.cards,"closing the viewer must not recreate the list");
        assert.ok(Math.abs(final.position-origin)<2,JSON.stringify({origin,final}));
        assert.deepEqual(network,[],"local cached photo browsing must not add API requests");
        let heapDelta=null;
        if(cdp){await cdp.send("HeapProfiler.collectGarbage");heapDelta=(await cdp.send("Runtime.getHeapUsage")).usedSize-before;assert.ok(heapDelta<12*1024*1024,String(heapDelta));}
        // Forward must restore the final viewed photo, not the first ID stored
        // in the browser entry. Serve only synthetic plaintext fixture records.
        const forwardData = await page.evaluate(async()=>({files:__test.state.files.map(({fileKey,...file})=>({...file,cryptoVersion:0})),png:[...new Uint8Array(await __thumb.blob.arrayBuffer())]}));
        await page.route("**/cloud/api/**",route=>route.request().url().includes("/view")
          ? route.fulfill({body:Buffer.from(forwardData.png),contentType:"image/png"})
          : route.fulfill({json:{files:forwardData.files,folders:[],breadcrumbs:[],folder:null}}));
        await page.goForward();
        await page.waitForFunction(id=>__test.state.previewFileId===id&&document.querySelector("#preview-stage img")?.naturalWidth>0,result.lastId);
        await page.locator("#preview-close").click();
        await page.waitForFunction(()=>__test.state.previewFileId===null&&!__test.state.previewClosePending);
        assert.deepEqual(errors,[]);
        console.log("PASS photo lifecycle",name,{pwa,photos:count,viewed:result.viewed,heapDelta,peakUrls:result.resources.maxUrls,finalResources:final.resources});
        await context.close();
      } finally {await browser.close();}
    }
  }
} finally {await fixture.close();}
