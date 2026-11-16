import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {provision,fixture,entry} from './fixture.mjs';
// Optional CPU-only comparison. No production API, real PRF, image bodies,
// IndexedDB, network latency or app rendering is included in these timings.
const root=resolve(import.meta.dirname,'../../..'),p=await provision(),f=await fixture(p),writer=await f.client('ownerA');writer.documentFormat=2;
const rows=new Array(1176);let cursor=0;
await Promise.all(Array.from({length:8},async()=>{while(cursor<rows.length){const i=cursor++,photos=Array.from({length:18},(_,j)=>{const id=crypto.randomUUID();return {id,fileName:`synthetic-${i}-${j}.jpg`,contentType:'image/jpeg',originalSize:3400000,width:4000,height:3000,createdByName:'Synthetic',createdAt:'2026-01-01T00:00:00Z',thumbnailUrl:`/diary/api/photos/${id}/thumbnail`,displayUrl:`/diary/api/photos/${id}/display`,originalUrl:`/diary/api/photos/${id}/original`};});const v=await writer.prepare(entry({entryDate:new Date(Date.UTC(2023,0,i+1)).toISOString().slice(0,10),title:`Synthetic ${i}`,content:'合成の本文です。'.repeat(80),photos}),{id:String(i+1)});rows[i]={...writer.preparedBindings.get(v),envelope:v.envelope,summary:v.summary,keyBox:v.keyBox,attestation:v.attestation};}}));writer.lock();f.close();
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic only</title>');return;}const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+sep))throw Error();res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const executablePath=process.env.TROOM_CHROMIUM_EXECUTABLE||[chromium.executablePath(),'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({headless:true,executablePath});
try{const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.evaluate(data=>{window.synthetic=data;},{profile:p.profiles.ownerA,anchor:p.anchor,prf:[...p.secrets.ownerA.prf],rows});const cdp=await page.context().newCDPSession(page);
  for(const rate of [1,4]){await cdp.send('Emulation.setCPUThrottlingRate',{rate});for(const lazy of [false,true]){
    const result=await page.evaluate(async({rate,lazy})=>{const {EncryptedDiaryClient}=await import('/diary-worker/e2ee/client.mjs'),f=window.synthetic,snapshot={version:1,household:'A',sequence:1,baseSequence:-1,delta:false,unchanged:false,records:f.rows,removed:[]};const client=new EncryptedDiaryClient({profile:f.profile,anchor:f.anchor,lazy,transport:{valid:async()=>true,snapshot:async()=>structuredClone(snapshot)}});const start=performance.now();await client.unlock(new Uint8Array(f.prf));const unlocked=performance.now();await client.sync();const indexed=performance.now();await client.ensureList(new URLSearchParams({limit:'20'}));const entries=client.list(new URLSearchParams({limit:'20'})),ready=performance.now();const result={cpuThrottle:rate,lazy,records:1176,photoMetadata:21168,unlockMs:Math.round(unlocked-start),indexMs:Math.round(indexed-unlocked),first20Ms:Math.round(ready-start),preparedBodies:[...client.records.values()].filter(r=>r.entry).length,firstEntryId:entries.entries[0].id,networkAndRendering:'excluded',samples:1};client.lock();return result;},{rate,lazy});console.log(JSON.stringify(result));
  }}
}finally{await browser.close();await new Promise(r=>server.close(r));}
