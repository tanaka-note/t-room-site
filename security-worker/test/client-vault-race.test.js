import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
globalThis.window = globalThis;
await import('../../cloud-worker/public/crypto-vault.js');

test('concurrent credential vault creation is immutable and preserves delegated keys', async () => {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  db.exec(`INSERT INTO security_identities(id,display_name,status) VALUES('identity','member','active');
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('credential','identity','public','salt','active');
    INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label) VALUES('link','identity','cloud','folder-member',7,'member');`);
  let reads = 0, release;
  const barrier = new Promise(resolve => {release=resolve;});
  function statement(sql, args=[]) {
    return {bind(...values){return statement(sql,values);}, async first(){
      const result=db.prepare(sql).get(...args)||null;
      // Force both legacy preflight reads to observe an absent row.
      if(sql.startsWith('SELECT public_key_fingerprint, public_key_jwk FROM security_tcloud_client_vaults') && !result) {
        if(++reads===2) release(); await barrier;
      }
      return result;
    }, async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};
  }
  const source=readFileSync(process.env.TCLOUD_TEST_SOURCE_ROOT ? resolve(process.env.TCLOUD_TEST_SOURCE_ROOT,'security-worker/src/index.js') : new URL('../src/index.js',import.meta.url),'utf8');
  const start=source.indexOf('async function saveOwnTCloudEnvelope(');
  const fn=source.slice(start,source.indexOf('\nasync function ',start+1));
  class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
  const canonicalJwk=jwk=>JSON.stringify({kty:jwk.kty,n:jwk.n,e:jwk.e});
  const context=vm.createContext({crypto, HttpError, SETUP_UV_TTL_SECONDS:300,
    requireSetupSession:async()=>({identityId:'identity',credentialId:'credential',setupId:'setup',last_user_verification_at:Math.floor(Date.now()/1000)}),
    nowSeconds:()=>Math.floor(Date.now()/1000),readJson:async request=>request,
    validatePublicJwk:jwk=>jwk,normalizeSecretText:value=>value,canonicalJwk,
    sha256:async value=>createHash('sha256').update(value).digest('base64url'),parseJson:JSON.parse,
    localAuditStatement:async()=>({run:async()=>({})}),tcloudSetupStatus:async()=>({tcloudReady:false}),json:value=>value});
  vm.runInContext(fn+'; globalThis.save=saveOwnTCloudEnvelope;',context);
  const env={DB:{prepare:statement,batch:async statements=>Promise.all(statements.map(s=>s.run()))}};
  const prf=crypto.getRandomValues(new Uint8Array(32));
  const vaults=await Promise.all([TRoomCrypto.createPasskeyClientVault(prf),TRoomCrypto.createPasskeyClientVault(prf)]);
  const rootBytes=crypto.getRandomValues(new Uint8Array(32));
  const delegations=await Promise.all(vaults.map(async vault=>{
    const publicKey=await crypto.subtle.importKey('jwk',vault.publicKeyJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    return Buffer.from(await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,rootBytes)).toString('base64');
  }));
  const bodies=vaults.map(v=>({serviceLinkId:'link',envelopeType:'client_private_prf',...v}));
  try {
    const results=await Promise.allSettled(bodies.map(body=>context.save(body,env)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'only the first distinct vault may succeed');
    assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
    const winner=results.findIndex(r=>r.status==='fulfilled');
    const before=db.prepare('SELECT * FROM security_tcloud_client_vaults').get();
    await context.save(bodies[winner],env);
    assert.deepEqual(db.prepare('SELECT * FROM security_tcloud_client_vaults').get(),before,'exact retry must not rewrite ciphertext/timestamps');
    await assert.rejects(context.save({...bodies[winner],encryptedPayload:'different ciphertext'},env),e=>e.status===409);
    await assert.rejects(context.save(bodies[1-winner],env),e=>e.status===409);
    assert.deepEqual(db.prepare('SELECT * FROM security_tcloud_client_vaults').get(),before);
    const privateKey=await TRoomCrypto.unlockPasskeyClientPrivateKey(prf,{encryptedPayload:before.encrypted_payload,payloadIv:before.payload_iv});
    const root=await TRoomCrypto.unlockDelegatedFolderKey(privateKey,delegations[winner]);
    assert.deepEqual(new Uint8Array(await crypto.subtle.exportKey('raw',root)),rootBytes,'saved winner can still decrypt the delegated root');
  } finally {db.close();}
});
