import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkerEntrypoint {constructor(ctx,env){this.ctx=ctx;this.env=env;}}',shortCircuit:true};
  return next(specifier,context);
}});
const {default:SecurityWorker}=await import('../src/index.js');
const {default:HouseholdWorker,SecurityIntegration}=await import('../../household-worker/src/index.js');
export function d1(db){return {prepare(sql){let values=[];return {bind(...v){values=v;return this;},async first(){return db.prepare(sql).get(...values)||null;},async all(){return {results:db.prepare(sql).all(...values)};},runSync(){return {meta:db.prepare(sql).run(...values)};},async run(){return this.runSync();}};},async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>s.runSync());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};}
function database(directory){const db=new DatabaseSync(':memory:');for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(name,directory),'utf8'));db.exec('PRAGMA foreign_keys=ON');return db;}
export async function automaticFixture(){
  const db=database(new URL('../../household-worker/migrations/',import.meta.url)),securityDb=database(new URL('../migrations/',import.meta.url));
  const recovery=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const recoveryPublicKey=await crypto.subtle.exportKey('jwk',recovery.publicKey);
  const ctx={waitUntil(promise){promise.catch(()=>{});}};
  const env={DB:d1(db),ENCRYPTION_REQUIRED:'true',SESSION_SECRET:randomBytes(32).toString('hex'),PASSKEY_ENABLED:'true',SESSION_VERSION:'1'};
  const securityEnv={DB:d1(securityDb),SESSION_SECRET:randomBytes(32).toString('hex'),PASSKEY_ENABLED:'true',RP_ID:'localhost',
    HOUSEHOLD_AUTH:new SecurityIntegration(ctx,env),CLOUD_AUTH:{async getPrimaryAdminCryptoConfig(){return {initialized:true,publicKeyJwk:recoveryPublicKey};}}};
  const security=new SecurityWorker(ctx,securityEnv),worker=new HouseholdWorker(ctx,env);env.SECURITY=security;
  function seed({identityId,credentialId,accountId,publicKey='cHVibGlj',salt=randomBytes(32).toString('base64url'),counter=0,vault,status='active',linkStatus='active'}){
    securityDb.prepare("INSERT OR IGNORE INTO security_identities(id,display_name,status,is_security_admin) VALUES (?,?,'active',?)").run(identityId,identityId,identityId==='primary-admin'?1:0);
    securityDb.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,counter,status,prf_enabled,transports_json) VALUES (?,?,?,?,?,?,1,'[\"internal\"]')").run(credentialId,identityId,publicKey,salt,counter,status);
    const serviceLinkId=`link-${identityId}-${accountId}`;
    securityDb.prepare("INSERT OR IGNORE INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES (?,?,'household',?,?,?)").run(serviceLinkId,identityId,accountId,accountId,linkStatus);
    if(vault)securityDb.prepare('INSERT INTO security_tcloud_client_vaults(credential_id,identity_id,public_key_jwk,encrypted_payload,payload_iv) VALUES (?,?,?,?,?)').run(credentialId,identityId,JSON.stringify(vault.publicKeyJwk),vault.encryptedPayload,vault.payloadIv);
    return {identityId,credentialId,serviceAccountId:accountId,serviceLinkId,passkeySessionEpoch:1};
  }
  async function client(user){
    const token=randomBytes(32).toString('base64url');
    securityDb.prepare('INSERT INTO security_handoffs(id,token_hash,identity_id,credential_id,service_link_id,expires_at,session_epoch) VALUES (?,?,?,?,?,?,1)').run(crypto.randomUUID(),createHash('sha256').update(token).digest('base64url'),user.identityId,user.credentialId,user.serviceLinkId,Math.floor(Date.now()/1000)+60);
    let cookie='',sessionContext='';
    async function request(path,body){return worker.fetch(new Request(`http://localhost/household/api${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','Content-Type':'application/json',Cookie:cookie,...(sessionContext?{'X-Household-Session':sessionContext}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
    async function api(path,body){const response=await request(path,body),value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status,code:value.code});return value;}
    const response=await request('/passkey/handoff',{handoffToken:token});cookie=response.headers.get('Set-Cookie')?.split(';')[0];const session=await response.json();if(!response.ok)throw new Error(`Fixture login ${response.status}`);sessionContext=session.sessionContext;
    return {api,request,session};
  }
  return {db,securityDb,env,securityEnv,security,worker,recovery,recoveryPublicKey,seed,client,close(){db.close();securityDb.close();}};
}
