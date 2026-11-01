import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {build}=require('esbuild');
export async function bundle(path,extra=''){
  const result=await build({stdin:{contents:readFileSync(path,'utf8')+extra,sourcefile:fileURLToPath(path),resolveDir:fileURLToPath(new URL('.',path))},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'fixture',setup(b){
    b.onResolve({filter:/^(cloudflare:workers|@simplewebauthn\/server)$/},a=>({path:a.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='cloudflare:workers'?'export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}':'export const generateAuthenticationOptions=async()=>({}),generateRegistrationOptions=async()=>({}),verifyAuthenticationResponse=async()=>({}),verifyRegistrationResponse=async()=>({});'}));
  }}]});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text+'\n//# sourceURL='+fileURLToPath(path).replaceAll('\\','/')).toString('base64')}`);
}
export function d1(sqlite){return {prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return sqlite.prepare(sql).get(...values)||null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},runSync(){return {meta:sqlite.prepare(sql).run(...values)};},async run(){return this.runSync();}};},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>s.runSync());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}

import {seedStatements} from '../tools/seed.mjs';
export const portfolio=await bundle(new URL('../src/index.js',import.meta.url),'\nexport {signSession};');
export function syntheticData(){
 const colors=['#ff8a61','#f4ca64','#a98cff','#52e6aa'],categories=['米株','インド株','ビットコイン','日本株'];
 return {schemaVersion:1,period:'2026-10-31',basePrincipal:1000000,realizedProfit:{name:'検証用売却益',value:5000},performanceAdjustmentName:'検証用調整',performanceAdjustmentSnapshots:[{effectiveFrom:'2026-09-01',cumulativeValue:-32000}],monthlyReport:{entries:[]},history:[{period:'2026-10-30',basePrincipal:1000000,rawMarketValue:1100000},{period:'2026-10-31',basePrincipal:1000000,rawMarketValue:1200000}],assets:categories.map((category,i)=>({id:'sample-'+i,name:'検証用銘柄'+i,category,marketValue:300000,costBasis:250000,color:colors[i]}))};
}
export function fixture(accountId='owner',identityId=accountId==='owner'?'primary-admin':'sample-viewer'){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
 for(const item of seedStatements(syntheticData()))sqlite.prepare(item.sql).run(...item.params);
 const sessions=new Map();let active=true,consumed=false,cookie='',sessionContext='';
 const env={DB:d1(sqlite),SESSION_SECRET:randomBytes(32).toString('hex'),PASSKEY_ENABLED:'true',SESSION_VERSION:'1',SECURITY:{
  async redeemHandoff(token,service){if(token!=='fixture-handoff'||consumed||service!=='portfolio')return null;consumed=true;return {identityId,serviceAccountId:accountId,credentialId:'fixture-credential',serviceLinkId:'fixture-link',sessionEpoch:1};},
  async passkeyRollingSession(input){if(!active||input.service!=='portfolio'||input.identityId!==identityId||input.serviceAccountId!==accountId)return {valid:false};if(input.action==='register')sessions.set(input.sessionIdHash,{valid:true,expiresAt:input.expiresAt});if(input.action==='end'){sessions.delete(input.sessionIdHash);return {valid:true};}return sessions.get(input.sessionIdHash)||{valid:false};},
  async recordAuditEvent(){return {stored:true};}
 },ASSETS:{async fetch(){return new Response('fixture shell');}}};
 const worker=new portfolio.default({},env);
 async function request(path,body,headers={},method){return worker.fetch(new Request(`https://example.test/asset-report${path}`,{method:method||(body===undefined?'GET':'POST'),headers:{Origin:'https://example.test','Content-Type':'application/json',Cookie:cookie,...(sessionContext?{'X-Portfolio-Session':sessionContext}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
 async function login(){const r=await request('/api/passkey/handoff',{handoffToken:'fixture-handoff'});if(r.status!==200)throw new Error(`login ${r.status}`);cookie=r.headers.get('Set-Cookie').split(';')[0];sessionContext=(await r.clone().json()).sessionContext;return r;}
 async function state(){return (await request('/api/data')).json();}
 async function save(record,extra={}){return request('/api/save',{requestId:crypto.randomUUID(),expectedRevision:(await state()).revision,record,...extra});}
 return {sqlite,env,worker,request,login,state,save,get cookie(){return cookie;},set cookie(v){cookie=v;},setActive(v){active=v;},close(){sqlite.close();}};

}
