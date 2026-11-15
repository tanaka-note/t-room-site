import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {calendarRequest} from '../src/api.js';
registerHooks({resolve(specifier,context,next){return specifier==='cloudflare:workers'?{url:'data:text/javascript,export class WorkerEntrypoint {}',shortCircuit:true}:next(specifier,context);}});
const Security=(await import('../../security-worker/src/index.js')).default;
function database(service){const db=new DatabaseSync(':memory:');const dir=new URL(`../../${service}-worker/migrations/`,import.meta.url);for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(file,dir),'utf8'));const prepare=(sql,args=[])=>({bind:(...a)=>prepare(sql,a),first:async()=>db.prepare(sql).get(...args)||null,all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:{changes:db.prepare(sql).run(...args).changes}})});return {db,binding:{prepare,async batch(items){db.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}}};}
test('real Security ledger registers Calendar, rolls only actual foreground data use, and revokes the next request',async()=>{
  const securityDb=database('security'),local=database('calendar'),OriginalDate=Date;let timestamp=OriginalDate.now();
  globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[timestamp]));}static now(){return timestamp;}};
  try{
    const credential='Y2FsZW5kYXItZml4dHVyZQ';securityDb.db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture','active',1);
      INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('${credential}','primary-admin','AQI','AQI','active');
      INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('calendar-link','primary-admin','calendar','main','Fixture','active')`);
    const security=Object.assign(new Security(),{env:{DB:securityDb.binding,SESSION_SECRET:randomBytes(48).toString('base64url'),PASSKEY_ENABLED:'true'},ctx:{waitUntil(){}}});
    const handoffs=new Map(),env={DB:local.binding,SESSION_SECRET:randomBytes(48).toString('base64url'),PASSKEY_ENABLED:'true',SESSION_VERSION:'1',SECURITY:{passkeyRollingSession:i=>security.passkeyRollingSession(i),recordAuditEvent:i=>security.recordAuditEvent(i),redeemHandoff:async token=>{const value=handoffs.get(token);handoffs.delete(token);return value;}}};
    async function request(path,cookie,body,active=false){const r=await calendarRequest(new Request('https://example.test/calendar/api/'+path,{method:body?'POST':'GET',headers:{Origin:'https://example.test','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(active?{'X-Troom-Activity':'foreground'}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);return{status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers,body:await r.json()};}
    async function login(){const token=randomUUID();handoffs.set(token,{identityId:'primary-admin',credentialId:credential,serviceLinkId:'calendar-link',serviceAccountId:'main',sessionEpoch:1});const r=await request('passkey/handoff',null,{handoffToken:token});assert.equal(r.status,200,JSON.stringify(r.body));assert.match(r.headers.get('set-cookie'),/Max-Age=2592000/);return r.cookie;}
    const cookie=await login();const original=JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0],'base64url'));
    timestamp+=25*86400000;
    assert.equal((await request('session',cookie,undefined,true)).headers.get('X-Troom-Session-Expires'),null);
    assert.equal((await request('sync',cookie)).cookie,undefined);
    const active=await request('sync',cookie,undefined,true);assert.equal(active.status,200);assert.ok(active.cookie);assert.ok(Number(active.headers.get('X-Troom-Session-Expires'))>original.expiresAt);
    timestamp+=6*86400000;assert.equal((await request('session',cookie)).status,401);assert.equal((await request('session',active.cookie)).status,200);
    securityDb.db.exec("UPDATE security_service_links SET status='disabled' WHERE id='calendar-link'");assert.equal((await request('sync',active.cookie)).status,401);
    assert.equal(securityDb.db.prepare("SELECT count(*) AS n FROM security_audit_events WHERE service='calendar' AND event_type='passkey_login_success'").get().n,1);
  }finally{globalThis.Date=OriginalDate;local.db.close();securityDb.db.close();}
});
