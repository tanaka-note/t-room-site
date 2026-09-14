import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHmac} from 'node:crypto';
import {context,env,handoff} from './session-fixture.mjs';
const OriginalDate=Date;let now=Date.now();
const FixedDate=class extends OriginalDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
globalThis.Date=FixedDate;context.Date=FixedDate;
const audit=[];context.recordSecurityAudit=async(_env,_request,event)=>audit.push(event);
async function request(path,cookie,body,headers={}) {
 const response=await context.worker.fetch(new Request('https://example.test/cloud/api'+path,{method:body?'POST':'GET',headers:{Origin:'https://example.test','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),env,{waitUntil(){}});
 const setCookie=response.headers.get('set-cookie');return {status:response.status,body:await response.json(),setCookie,cookie:setCookie?.split(';')[0]};
}
const decode=cookie=>JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0],'base64url'));
const sign=payload=>{const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');return 'troom_cloud_session='+encoded+'.'+createHmac('sha256',env.SESSION_SECRET).update(encoded).digest('base64url');};
try {
 for(const role of ['admin','subadmin']) {
  const login=await request('/login',null,{loginId:role+'@test',authProof:'local-proof'});
  assert.equal(login.status,200,JSON.stringify(login.body));
  const payload=decode(login.cookie);
  assert.equal(payload.exp,Math.floor(Date.parse(payload.startedAt)/1000)+43200);
  assert.equal(payload.passwordSessionVersion,1);assert.equal(login.body.expiresAt,payload.exp);
  assert.doesNotMatch(login.setCookie,/Max-Age|Expires=/i);assert.equal(audit.at(-1).expiresAt,payload.exp);
  const pk=await handoff('admin');const pkPayload=decode(pk.cookie);assert.equal(pkPayload.passwordSessionVersion,undefined);
  for(const extra of [{passwordSessionVersion:undefined},{passwordSessionVersion:undefined,authMethod:undefined},{exp:payload.exp+2592000}])assert.equal((await request('/session',sign({...payload,...extra}))).body.authenticated,false);
  for(const elapsed of [0,1,39600,43199]) {
   now=(payload.exp-43200+elapsed)*1000+999;
   const resumed=await request('/session',login.cookie);
   assert.equal(resumed.body.authenticated,true);assert.equal(resumed.body.expiresAt,payload.exp);assert.equal(resumed.setCookie,null);assert.equal(audit.at(-1).expiresAt,payload.exp);
   assert.equal((await request('/session',pk.cookie)).body.authenticated,true);
  }
  now=payload.exp*1000;
  assert.equal((await request('/session',login.cookie)).body.authenticated,false);
  assert.equal((await request('/items',login.cookie)).status,401);
  now=pkPayload.exp*1000;assert.equal((await request('/session',pk.cookie)).body.authenticated,false);
 }
} finally {globalThis.Date=OriginalDate;context.Date=OriginalDate;}

// The real browser guard expires without a per-thumbnail session request.
let clock=100000,invalidations=0,fetches=0,callback;const local=new Map(),tab=new Map();
const store=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)});
const guard={fetch:async()=>{fetches++;return new Response('{}');},localStorage:store(local),sessionStorage:store(tab),Headers,URL,AbortController,ReadableStream,Response,Event,crypto,
 Date:{now:()=>clock},setTimeout:fn=>(callback=fn,1),clearTimeout(){callback=null;},addEventListener(){},dispatchEvent(){invalidations++;},location:{origin:'https://example.test',href:'https://example.test/cloud/',replace(){}},BroadcastChannel:class {postMessage(){}}};
guard.globalThis=guard;vm.runInNewContext(readFileSync(new URL('../public/session-guard.js',import.meta.url),'utf8'),guard);
guard.TCloudSession.bind({sessionCacheId:'authenticated',expiresAt:101,role:'admin'});
const pending=new AbortController();guard.TCloudSession.track(pending);
for(let i=0;i<100;i++)guard.TCloudSession.check();assert.equal(fetches,0);
clock=101000;callback();assert.equal(invalidations,1);assert.equal(pending.signal.aborted,true);assert.equal(guard.TCloudSession.context(),null);assert.equal(guard.TCloudSession.isBlocked(),true);
assert.match(readFileSync(new URL('../public/cloud.js',import.meta.url),'utf8'),/addEventListener\?\.\("tcloud-session-invalid", releaseSessionState\)/);
console.log('PASS Cloud admin/subadmin fixed expiry, old password rejection, unchanged Passkey, exact audit exp, local expiry cleanup');
