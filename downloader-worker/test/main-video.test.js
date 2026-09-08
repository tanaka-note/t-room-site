import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canExploreAnalysis, terminalAnalysisError, assertPublicDestination, publicAddress, exploreMainVideo, mainVideoOutbound } from '../src/main-video.js';
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const dns=addresses=>async()=>Response.json({Status:0,Answer:addresses.map(data=>({type:data.includes(':')?28:1,data}))});

test('recoverable extractor failures explore once; explicit refusals never explore',()=>{
 for(const code of ['metadata_timeout','extractor_failed','metadata_invalid','media_not_found']) {
  assert.equal(canExploreAnalysis(code),true);assert.equal(terminalAnalysisError(code),true);
 }
 for(const code of ['drm','login_required','geo_restricted','policy_restricted','access_denied','bot_challenge']) {
  assert.equal(canExploreAnalysis(code),false);assert.equal(terminalAnalysisError(code),true);
 }
 assert.equal(canExploreAnalysis('ssrf_blocked'),false);
 assert.equal(terminalAnalysisError('container_draining'),false);
});

test('page-associated frame and scripts receive bounded exact permissions without site configuration',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=dns(['8.8.8.8']);const policies=[],calls=[];
 const container={async claimMainVideoExploration(){return true},async setAllowedHosts(){},async setOutboundHandler(_name,p){policies.push(p)},async fetch(req){
  const b=await req.json();calls.push(b);
  return Response.json(b.phase==='prepare'?{page:'https://player.example/embed/123',scripts:['https://assets.example/player.js']}:
   b.phase==='discover'?{url:'https://cdn.example/main.mp4'}:{extractor:'main-video',media:[]});
 }};
 try {
  const result=await exploreMainVideo({MAIN_VIDEO_FALLBACK:'true'},container,new URL('https://example.com/watch'),Date.now()+120000,1024,
   {page:'https://example.com/watch',embed:'https://player.example/embed/123',scripts:[]});
  assert.equal(result.extractor,'main-video');assert.deepEqual(calls.map(x=>x.phase),['prepare','discover','validate']);
  assert.deepEqual(policies.at(-1).hosts,['example.com','player.example','assets.example','cdn.example']);
  assert.equal(new Set(calls.map(x=>x.expiresAtMs)).size,1);
 } finally {globalThis.fetch=previous}
});

test('public DNS rejects private, mixed, special-use, mapped IP and DNS failure',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2002:7f00:1::','2001:db8::1','192.0.2.1'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
 await assert.rejects(assertPublicDestination('https://example.com',undefined,dns(['8.8.8.8','10.1.1.1'])));
 await assert.rejects(assertPublicDestination('https://example.com',undefined,dns([])));
 await assert.rejects(assertPublicDestination('https://metadata.google.internal',undefined,dns(['8.8.8.8'])));
 await assert.rejects(assertPublicDestination('https://example.com',undefined,async()=>Response.json({Status:2})));
});

test('strict outbound checks DNS at every send and fails a rebinding before fetch',async()=>{
 const previous=globalThis.fetch;let origin=0,privateNow=false;
 globalThis.fetch=async(url,init)=>{
   if(String(url).startsWith('https://cloudflare-dns.com/'))return dns([privateNow?'127.0.0.1':'8.8.8.8'])();
   origin++;assert.equal(init.redirect,'manual');assert.equal(init.headers.get('cookie'),null);assert.equal(init.headers.get('authorization'),null);
   assert.equal(init.headers.get('X-Real-IP'),'2a06:98c0:3600::103');
   return new Response('ok');
 };
 try{
 const ctx={params:{hosts:['example.com'],until:Date.now()+1000,bounded:true}};
 assert.equal((await mainVideoOutbound(new Request('https://example.com',{headers:{Cookie:'secret',Authorization:'secret'}}),{},ctx)).status,200);
 privateNow=true;
 assert.equal((await mainVideoOutbound(new Request('https://example.com'),{},ctx)).status,403);
 assert.equal((await mainVideoOutbound(new Request('https://other.com'),{},ctx)).status,403);
 assert.equal((await mainVideoOutbound(new Request('https://example.com',{method:'POST'}),{},ctx)).status,403);
 assert.equal(origin,1);
 }finally{globalThis.fetch=previous}
});

test('supplemental discovery is disabled or skipped without time, and one claim spans retries',async()=>{
 let claims=0,fetches=0,used=false;const methods=[];
 const container={async claimMainVideoExploration(){claims++;if(used)return false;used=true;return true},async setAllowedHosts(hosts){assert.deepEqual(hosts,['example.com'])},async setOutboundHandler(method){methods.push(method)},async fetch(){fetches++;return Response.json({errorCode:'main_video_unavailable'},{status:422})}};
 const url=new URL('https://example.com/watch'),env={MAIN_VIDEO_FALLBACK:'true'};
 assert.equal(await exploreMainVideo({},container,url,Date.now()+120000,1024),null);
 assert.equal(await exploreMainVideo(env,container,url,Date.now()+100,1024),null);
 assert.equal(claims,0);
 await exploreMainVideo(env,container,url,Date.now()+120000,1024);
 await exploreMainVideo(env,container,url,Date.now()+120000,1024);
 assert.equal(claims,2);assert.equal(fetches,1);assert.deepEqual(methods,['mainVideo']);
});

test('candidate revalidation has the same ten-second absolute budget and exact CDN permission',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=dns(['8.8.8.8']);const policies=[],calls=[];
 const result={extractor:'main-video',media:[{downloadable:true}]};
 const container={async claimMainVideoExploration(){return true},async setAllowedHosts(hosts){assert.ok(hosts.every(x=>!x.includes('*')))},async setOutboundHandler(_name,params){policies.push(params)},async fetch(request){const body=await request.json();calls.push(body);assert.ok(body.budgetSeconds<=10);return Response.json(body.phase==='discover'?{url:'https://cdn.example/movie.m3u8',title:'Main'}:result)}};
 try{assert.equal((await exploreMainVideo({MAIN_VIDEO_FALLBACK:'true'},container,new URL('https://example.com/watch'),Date.now()+120000,1024)).extractor,'main-video');
 assert.deepEqual(calls.map(x=>x.phase),['discover','validate']);assert.equal(policies[0].until,policies[1].until);
 assert.deepEqual(policies[1].hosts,['example.com','cdn.example']);
 }finally{globalThis.fetch=previous}
});

test('slow RPC cannot extend remaining analysis time or start a browser later',async()=>{
 let fetches=0;
 const container={async claimMainVideoExploration(){await new Promise(r=>setTimeout(r,1100));return true},async fetch(){fetches++}};
 const start=Date.now();await exploreMainVideo({MAIN_VIDEO_FALLBACK:'true'},container,new URL('https://example.com'),start+1050,1024);
 assert.ok(Date.now()-start<1150);
 await new Promise(r=>setTimeout(r,100));assert.equal(fetches,0);
});

test('actual analysis caller gates extra work on recoverable errors and preserves cancellation CAS',()=>{
 const body=source.slice(source.indexOf('async function processAnalyzeMessage('),source.indexOf('async function analysisIsCancelled('));
 assert.match(body,/response\.status === 422 && canExploreAnalysis\(analysis\.errorCode\)/);
 assert.match(body,/!await analysisIsCancelled\(env, message\)/);
 assert.match(body,/status = 'analyzing' AND processing_token = \?/);
 assert.match(body,/analysisStartedAt \+ ANALYSIS_TIMEOUT_MS/);
 assert.ok(body.indexOf('if (!response.ok &&')<body.indexOf('await exploreMainVideo'));
});

test('DO claim survives recreation, refuses cancellation, and reset preserves normal retry handler',async()=>{
 const data=new Map();let standard=0,allowed=0;
 const storage={async get(k){return data.get(k)},async put(k,v){data.set(k,v)},async transaction(fn){return fn(this)}};
 class Container{constructor(){this.ctx={storage}}async setAllowedHosts(){allowed++}async setOutboundHandler(name){assert.equal(name,'standard');standard++}}
 const ctx={Container,PRIVATE_DESTINATIONS:[],AbortController,Set,Response,Request,AbortSignal};vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('export class DownloaderContainer'),source.indexOf('DownloaderContainer.outboundByHost')).replace('export class','class')+';globalThis.C=DownloaderContainer;',ctx);
 assert.equal(await new ctx.C().claimMainVideoExploration(),true);
 assert.equal(await new ctx.C().claimMainVideoExploration(),false);
 data.clear();data.set('analysisCancelled',true);assert.equal(await new ctx.C().claimMainVideoExploration(),false);
 const c=new ctx.C();await c.setAllowedHosts(['example.com']);assert.equal(standard,0);
 c.outboundHandlerOverride={method:'mainVideo'};await c.setAllowedHosts(['example.com']);assert.equal(standard,1);assert.equal(allowed,2);
});
