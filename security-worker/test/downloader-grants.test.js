import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {build}=require('esbuild');
const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const names=['ensurePrimaryAdminRecords','createIdentityAndInvite','invitationOptions','invitationVerify','approveIdentity','reinviteIdentity','addIdentityLinks','removeIdentityLink','authenticationOptions','authenticationVerify','createHandoff','redeemHandoff','validatePasskeySession'];
// Only the WebAuthn device ceremony and provider descriptions are mocked. Actual
// handlers, session signatures, authorization SQL and atomic D1 batches run.
const result=await build({stdin:{contents:source+`\nexport {${names.join(',')}};`,resolveDir:fileURLToPath(new URL('../src/',import.meta.url)),sourcefile:'index.js'},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'test-boundaries',setup(b){
 b.onResolve({filter:/^(cloudflare:workers|@simplewebauthn\/server)$/},a=>({path:a.path,namespace:'test'}));
 b.onLoad({filter:/.*/,namespace:'test'},a=>({contents:a.path==='cloudflare:workers'?'export class WorkerEntrypoint {}':`
 export const generateRegistrationOptions=async()=>({challenge:crypto.randomUUID()});
 export const generateAuthenticationOptions=async input=>({...input,challenge:crypto.randomUUID()});
 export const verifyRegistrationResponse=async({response,expectedChallenge})=>({verified:response.fixtureVerified===true&&await expectedChallenge(response.challenge),registrationInfo:{userVerified:true,credential:{id:response.id,publicKey:new Uint8Array([1,2]),counter:0},credentialDeviceType:'singleDevice',credentialBackedUp:false}});
 export const verifyAuthenticationResponse=async({response,expectedChallenge})=>({verified:response.fixtureVerified===true&&await expectedChallenge(response.challenge),authenticationInfo:{userVerified:true,newCounter:1}});
 `}));
}}]});
const worker=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text+'\n//# sourceURL=security-grants-fixture.mjs').toString('base64')}`);
const url=new URL('https://example.test/security/');
const req=(body={},cookie='')=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
const now=()=>Math.floor(Date.now()/1000);
function fixture(){
 const db=new DatabaseSync(':memory:');
 const dir=new URL('../migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync(new URL(f,dir),'utf8'));
 db.exec('PRAGMA foreign_keys=ON');
 const prepare=sql=>{let values=[];const stmt={bind(...v){values=v;return stmt},async first(){return db.prepare(sql).get(...values)||null},async all(){return {results:db.prepare(sql).all(...values)}},async run(){return {meta:db.prepare(sql).run(...values)}}};return stmt};
 const provider={async describeAccount({accountId,rootFolderId}){return {valid:true,accountId,rootFolderId:rootFolderId??null,displayLabel:accountId,role:accountId==='owner'?'owner':'user',privileged:accountId==='owner'}}};
 const env={DB:{prepare,async batch(statements){db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}},PASSKEY_ENABLED:'true',SESSION_SECRET:'fixture-secret',RP_ID:'example.test',EXPECTED_ORIGIN:url.origin,DOWNLOADER_AUTH:provider,DIARY_AUTH:provider,BILLING_AUTH:provider,AI_AUTH:provider};
 const admin={identityId:'primary-admin',authenticatedAt:now()};
 const count=id=>db.prepare("SELECT count(*) n FROM security_service_links WHERE identity_id=? AND service='downloader' AND status!='disabled'").get(id).n;
 const create=async id=>(await worker.createIdentityAndInvite(req({identityId:id,displayName:id,links:[{service:'diary',accountId:id}],expiresAt:now()+86400}),env,admin)).json();
 const seed=async id=>{db.prepare("INSERT INTO security_identities(id,display_name,status) VALUES(?,?,'active')").run(id,id);const credential=Buffer.from(id).toString('base64url');db.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES(?,?,'AQI','YWJj','active')").run(credential,id);return credential};
 const grant=async id=>worker.addIdentityLinks(id,req({links:[{service:'downloader',accountId:'owner'}]}),env,admin);
 const signIn=async(id,service)=>{const credential=Buffer.from(id).toString('base64url');const opts=await (await worker.authenticationOptions(req({service}),env)).json();const response=await worker.authenticationVerify(req({service,challengeId:opts.challengeId,response:{id:credential,challenge:opts.options.challenge,fixtureVerified:true}}),env,url);return response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 return {db,env,admin,count,create,seed,grant,signIn,close:()=>db.close()};
}
test('owner defaults and repeated migrations never grant Downloader to other identities',async()=>{
 const f=fixture();try{await f.seed('primary-admin');await f.seed('user-a');await f.seed('user-b');await worker.ensurePrimaryAdminRecords(f.env);await worker.ensurePrimaryAdminRecords(f.env);assert.equal(f.count('primary-admin'),1);assert.equal(f.count('user-a'),0);assert.equal(f.count('user-b'),0);
 for(let i=0;i<2;i++){f.db.exec(readFileSync(new URL('../migrations/0011_downloader_service.sql',import.meta.url),'utf8'));f.db.exec(readFileSync(new URL('../migrations/0017_account_display_names.sql',import.meta.url),'utf8'))}assert.equal(f.count('primary-admin'),1);assert.equal(f.count('user-a'),0);assert.equal(f.count('user-b'),0);assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
 await assert.rejects(worker.removeIdentityLink(f.db.prepare("SELECT id FROM security_service_links WHERE service='downloader'").get().id,req(),f.env,f.admin),e=>e.status===409);
 }finally{f.close()}
});
test('creation, passkey registration, approval, reinvitation and other-service additions do not grant Downloader',async()=>{
 const f=fixture();try{await f.seed('primary-admin');const invitation=await f.create('new-user');assert.equal(f.count('new-user'),0);
 const token=new URL(invitation.invitationUrl,url).hash.slice('#invite='.length);const options=await (await worker.invitationOptions(req({token}),f.env)).json();
 const registered=await (await worker.invitationVerify(req({token,challengeId:options.challengeId,response:{id:Buffer.from('new-user').toString('base64url'),challenge:options.options.challenge,fixtureVerified:true}}),f.env,url)).json();assert.equal(f.count('new-user'),0);
 await worker.approveIdentity('new-user',req({credentialId:registered.credentialId}),f.env,f.admin);assert.equal(f.count('new-user'),0);
 await worker.reinviteIdentity('new-user',req({expiresAt:now()+86400}),f.env,f.admin);assert.equal(f.count('new-user'),0);
 await worker.addIdentityLinks('new-user',req({links:[{service:'billing',accountId:'new-user'}]}),f.env,f.admin);assert.equal(f.count('new-user'),0);
 await assert.rejects(worker.createIdentityAndInvite(req({identityId:'rejected',displayName:'rejected',links:[{service:'downloader',accountId:'owner'}]}),f.env,f.admin),e=>e.status===400);assert.equal(f.db.prepare("SELECT count(*) n FROM security_identities WHERE id='rejected'").get().n,0);
 const audits=f.db.prepare("SELECT * FROM security_audit_events WHERE event_type='service_link_added'").all();assert.equal(audits.length,2);for(const a of audits){assert.ok(a.service_link_id);assert.equal(JSON.parse(a.details_json).changedBy,'primary-admin')};assert.equal(JSON.parse(audits[0].details_json).source,'identity_invitation');
 }finally{f.close()}
});
test('only an explicit fresh owner grant enables the exact identity, link and service; revocation invalidates old sessions and handoffs',async()=>{
 const f=fixture();try{await f.seed('primary-admin');await f.seed('user-a');await f.seed('user-b');await worker.ensurePrimaryAdminRecords(f.env);
 const ownerCookie=await f.signIn('primary-admin','downloader');const ownerHandoff=await (await worker.createHandoff(req({service:'downloader'},ownerCookie),f.env)).json();const owner=await worker.redeemHandoff(f.env,ownerHandoff.handoffToken,'downloader');
 await assert.rejects(f.signIn('user-a','downloader'),e=>e.status===403);
 await assert.rejects(worker.addIdentityLinks('user-a',req({links:[{service:'downloader',accountId:'owner'}]}),f.env,{identityId:'user-b',authenticatedAt:now()}),e=>e.status===403);
 await assert.rejects(worker.addIdentityLinks('user-a',req({links:[{service:'downloader',accountId:'owner'}]}),f.env,{...f.admin,authenticatedAt:now()-301}),e=>e.status===428);
 await f.grant('user-a');assert.equal(f.count('user-a'),1);assert.equal(f.count('user-b'),0);
 const options=await (await worker.authenticationOptions(req({service:'downloader'}),f.env)).json();assert.deepEqual(options.options.allowCredentials.map(c=>c.id).sort(),['primary-admin','user-a'].map(v=>Buffer.from(v).toString('base64url')).sort());
 const cookie=await f.signIn('user-a','downloader');const link=f.db.prepare("SELECT id FROM security_service_links WHERE identity_id='user-a'").get().id;
 await assert.rejects(worker.createHandoff(req({service:'downloader',linkId:owner.serviceLinkId},cookie),f.env),e=>e.status===409);
 const handoff=await (await worker.createHandoff(req({service:'downloader',linkId:link},cookie),f.env)).json();assert.equal(await worker.redeemHandoff(f.env,handoff.handoffToken,'diary'),null);
 const session=await worker.redeemHandoff(f.env,handoff.handoffToken,'downloader');assert.equal(session.identityId,'user-a');assert.equal((await worker.validatePasskeySession(f.env,session)).valid,true);
 assert.equal(await worker.redeemHandoff(f.env,handoff.handoffToken,'downloader'),null);
 assert.equal((await worker.validatePasskeySession(f.env,{...session,identityId:'user-b'})).valid,false);assert.equal((await worker.validatePasskeySession(f.env,{...session,serviceLinkId:owner.serviceLinkId})).valid,false);
 const pending=await (await worker.createHandoff(req({service:'downloader'},cookie),f.env)).json();
 // Simulate malformed persisted data: a credential/identity's handoff points to another user's link.
 f.db.prepare("UPDATE security_handoffs SET service_link_id=? WHERE consumed_at IS NULL AND identity_id='user-a'").run(owner.serviceLinkId);
 assert.equal(await worker.redeemHandoff(f.env,pending.handoffToken,'downloader'),null);
 const old=await (await worker.createHandoff(req({service:'downloader'},cookie),f.env)).json();
 await worker.removeIdentityLink(link,req(),f.env,f.admin);assert.equal(f.count('user-a'),0);assert.equal((await worker.validatePasskeySession(f.env,session)).valid,false);assert.equal(await worker.redeemHandoff(f.env,old.handoffToken,'downloader'),null);assert.equal((await worker.validatePasskeySession(f.env,owner)).valid,true);
 await f.grant('user-a');assert.equal((await worker.validatePasskeySession(f.env,session)).valid,false);assert.equal(f.db.prepare("SELECT count(*) n FROM security_service_links WHERE identity_id='user-a'").get().n,2);
 const audits=f.db.prepare("SELECT service_link_id,details_json FROM security_audit_events WHERE event_type='service_link_added' AND service='downloader'").all();assert.equal(audits.length,2);assert.equal(JSON.parse(audits[0].details_json).source,'identity_link_add');assert.notEqual(audits[0].service_link_id,audits[1].service_link_id);
 }finally{f.close()}
});

test('Downloader request validation denies missing, disabled and deleted links without affecting owner sessions',async()=>{
 const f=fixture();try{await f.seed('primary-admin');await f.seed('user-a');await f.seed('user-b');await worker.ensurePrimaryAdminRecords(f.env);await f.grant('user-a');
 const sessions={};for(const id of ['primary-admin','user-a']){const cookie=await f.signIn(id,'downloader');const h=await (await worker.createHandoff(req({service:'downloader'},cookie),f.env)).json();sessions[id]=await worker.redeemHandoff(f.env,h.handoffToken,'downloader')}
 const src=readFileSync(new URL('../../downloader-worker/src/index.js',import.meta.url),'utf8');const body=src.slice(src.indexOf('async function requireSession('),src.indexOf('async function analyzeSource('));
 class HttpError extends Error{constructor(status,message){super(message);this.status=status}}
 const requireSession=new Function('verifySession','passkeysEnabled','parseCookies','HttpError','SESSION_COOKIE',body+';return requireSession;')(async token=>sessions[token],()=>true,raw=>({fixture:raw}),HttpError,'fixture');
 const env={SECURITY:{validatePasskeySession:input=>worker.validatePasskeySession(f.env,input)}};
 // Downloader cookies use passkeySessionEpoch; Security handoffs use sessionEpoch.
 for(const s of Object.values(sessions))s.passkeySessionEpoch=s.sessionEpoch;
 await requireSession(req({},'user-a'),env);await requireSession(req({},'primary-admin'),env);
 const a=sessions['user-a'];f.db.prepare(`INSERT INTO security_active_sessions(session_id_hash,identity_id,service,service_link_id,service_account_id,credential_id,role,auth_method,session_version,started_at,last_seen_at,expires_at) VALUES('test-session',?,'downloader',?,'owner',?,'owner','passkey','1','2026-09-01','2026-09-01',?)`).run(a.identityId,a.serviceLinkId,a.credentialId,now()+1000);
 await worker.removeIdentityLink(a.serviceLinkId,req(),f.env,f.admin);assert.equal(f.db.prepare("SELECT end_reason FROM security_active_sessions WHERE session_id_hash='test-session'").get().end_reason,'service_link_disabled');
 await assert.rejects(requireSession(req({},'user-a'),env),e=>e.status===401);await requireSession(req({},'primary-admin'),env);
 f.db.prepare('DELETE FROM security_handoffs WHERE service_link_id=?').run(a.serviceLinkId);f.db.prepare('DELETE FROM security_service_links WHERE id=?').run(a.serviceLinkId);
 await assert.rejects(requireSession(req({},'user-a'),env),e=>e.status===401);await requireSession(req({},'primary-admin'),env);
 }finally{f.close()}
});
