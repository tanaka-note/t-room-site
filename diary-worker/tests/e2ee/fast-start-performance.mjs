// Optional local CPU/IndexedDB comparison. Synthetic data only; real passkeys,
// server authorization latency, network and DOM rendering are excluded.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { provision, fixture, entry } from './fixture.mjs';

const root=resolve(import.meta.dirname,'../../..'),p=await provision(),f=await fixture(p),writer=await f.client('ownerA');
writer.documentFormat=2;
const rows=new Array(1200);let cursor=0;
await Promise.all(Array.from({length:8},async()=>{
  while(cursor<rows.length){
    const i=cursor++,photos=Array.from({length:18},(_,j)=>({id:crypto.randomUUID(),fileName:`synthetic-${i}-${j}.jpg`,contentType:'image/jpeg',originalSize:3400000,width:4000,height:3000}));
    const proposal=await writer.prepare(entry({entryDate:new Date(Date.UTC(2023,0,i+1)).toISOString().slice(0,10),title:`Synthetic ${i}`,content:'合成本文。'.repeat(80),photos}),{id:String(i+1)});
    rows[i]={...writer.preparedBindings.get(proposal),envelope:proposal.envelope,summary:proposal.summary,keyBox:proposal.keyBox,attestation:proposal.attestation};
  }
}));writer.lock();f.close();
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic cache timing</title>');return;}
    const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+sep))throw new Error('InvalidFixturePath');
    res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async data=>{
    window.synthetic=data;
    const {EncryptedDiaryClient}=await import('/diary-worker/e2ee/client.mjs'),{openCipherCache}=await import('/diary-worker/e2ee/cache.mjs');
    const snapshot={version:1,household:'A',sequence:1,baseSequence:-1,delta:false,unchanged:false,records:data.rows,removed:[]};
    window.fixtureCache=await openCipherCache('synthetic-first-view-'+crypto.randomUUID());
    window.fixtureTransport={valid:async()=>true,snapshot:async(h,since)=>since>=0?{...snapshot,baseSequence:since,delta:true,unchanged:true,records:[]}:structuredClone(snapshot)};
    const client=new EncryptedDiaryClient({profile:data.profile,anchor:data.anchor,cache:window.fixtureCache,lazy:true,transport:window.fixtureTransport});
    await client.unlock(new Uint8Array(data.prf));await client.sync();await client.ensureList(new URLSearchParams({limit:'5'}));await client.persistPreparedIndex();
    if(![...client.records.values()].some(row=>row.entry))throw new Error('FixtureNotPrepared');
    client.lock();
  },{profile:p.profiles.ownerA,anchor:p.anchor,prf:[...p.secrets.ownerA.prf],rows});
  const cdp=await page.context().newCDPSession(page);
  for(const rate of [1,4]){
    await cdp.send('Emulation.setCPUThrottlingRate',{rate});
    for(const fast of [false,true]){
      const samples=[];
      for(let i=0;i<3;i++)samples.push(await page.evaluate(async fast=>{
        const {EncryptedDiaryClient}=await import('/diary-worker/e2ee/client.mjs'),data=window.synthetic;
        const client=new EncryptedDiaryClient({profile:data.profile,anchor:data.anchor,cache:fast?window.fixtureCache:{...window.fixtureCache,getIndex:async()=>undefined},lazy:true,transport:window.fixtureTransport});
        await client.unlock(new Uint8Array(data.prf));
        const verify=crypto.subtle.verify;let verifications=0;
        crypto.subtle.verify=async function(...args){verifications++;return verify.apply(this,args);};
        try{
          const start=performance.now();await client.sync();await client.ensureList(new URLSearchParams({limit:'5'}));
          return {firstFiveMs:Math.round(performance.now()-start),verifications,firstId:client.list(new URLSearchParams({limit:'5'})).entries[0].id};
        }finally{crypto.subtle.verify=verify;client.lock();}
      },fast));
      assert.ok(samples.every(sample=>sample.firstId===1200));
      assert.ok(samples.every(sample=>sample.verifications===(fast?5:1200)));
      console.log(JSON.stringify({cpuThrottle:rate,fast,records:1200,photoMetadata:21600,samples:3,medianFirstFiveMs:[...samples].sort((a,b)=>a.firstFiveMs-b.firstFiveMs)[1].firstFiveMs,verifications:samples[0].verifications,excluded:'passkey, authorization/network latency, DOM, physical Android'}));
    }
  }
  await page.evaluate(()=>window.fixtureCache.close());
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
