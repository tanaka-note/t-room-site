import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {context,env} from './session-fixture.mjs';
import {engines} from './ui-fixture.mjs';

const before=process.argv.includes('--reproduce');
// Exercise the real Worker router and real browser scope matching, using only
// a synthetic local-media response. No production credentials or media.
env.ASSETS={fetch:async request=>{
  const path=new URL(request.url).pathname;
  if(path==='/')return new Response('<!doctype html><body><output id="result"></output><script src="/cloud/cloud.js"></script>',{headers:{'Content-Type':'text/html'}});
  if(path.includes('cloud-runtime'))return new Response(`(async()=>{
    const r=await navigator.serviceWorker.register('/cloud/media-worker.js',{scope:'/cloud/'});
    const w=r.installing||r.waiting||r.active;
    if(w.state!=='activated')await new Promise(resolve=>w.addEventListener('statechange',()=>{if(w.state==='activated')resolve();}));
    await new Promise(resolve=>setTimeout(resolve,300));
    const response=await fetch('/cloud/local-media/probe');
    const result=document.querySelector('#result');
    result.dataset.controlled=String(!!navigator.serviceWorker.controller);
    result.dataset.status=String(response.status);
    result.textContent=await response.text();
  })();`,{headers:{'Content-Type':'text/javascript'}});
  if(path.includes('media-worker'))return new Response(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/cloud/local-media/probe')event.respondWith(new Response('local-only'));});`,{headers:{'Content-Type':'text/javascript'}});
  return new Response('Not found',{status:404});
}};
const server=createServer(async(req,res)=>{
  try{
    const response=await context.worker.fetch(new Request('http://127.0.0.1:'+server.address().port+req.url,{method:req.method}),env,{waitUntil(){}});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
try{
  const response=await fetch(origin+'/cloud?view=all',{redirect:'manual'});
  assert.equal(response.status,before?200:308);
  if(!before){
    assert.equal(response.headers.get('location'),origin+'/cloud/?view=all');
    assert.equal((await fetch(origin+'/cloud',{method:'HEAD',redirect:'manual'})).status,308);
  }
  for(const [name,engine,launch] of engines){
    const browser=await engine.launch({headless:true,...launch});
    try{
      const page=await browser.newPage();await page.goto(origin+'/cloud?view=all#position');
      await page.locator('#result[data-status]').waitFor();
      const result=await page.locator('#result').evaluate(e=>({controlled:e.dataset.controlled,status:e.dataset.status,text:e.textContent}));
      assert.deepEqual(result,before?{controlled:'false',status:'404',text:'Not found'}:{controlled:'true',status:'200',text:'local-only'});
      assert.equal(new URL(page.url()).hash,'#position');
      assert.equal(new URL(page.url()).search,'?view=all');
      console.log(before?'REPRODUCED slashless Cloud bypasses local media worker':'PASS canonical Cloud URL preserves query/hash and local media control',name,result);
    }finally{await browser.close();}
  }
}finally{await new Promise(resolve=>server.close(resolve));}
