import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticFixture,d1} from './household-automatic-fixture.mjs';
import {DatabaseSync} from 'node:sqlite';
import {prepareAutomaticKeys,shareAutomaticKeys,unlockAutomaticPrivate} from '../../household-worker/public/automatic-keys.mjs';
import {createEncryptedLedger} from '../../household-worker/public/encrypted-ledger.mjs';
import {createClientVault,unwrapMaster,keyScope} from '../../household-worker/public/household-crypto.mjs';
import {keyBundle,manageKeys} from '../../household-worker/src/keys.js';
globalThis.window=globalThis;
await import('../../cloud-worker/public/crypto-vault.js');
// Ciphertext compatibility context, retained exactly as used by T-Cloud.
const ADMIN_WRAP_CONTEXT = "T-ROOM Cloud Storage admin private key v1";
const prf=()=>crypto.getRandomValues(new Uint8Array(32));
async function person(f,identityId,accountId,{prepared=true,status='active',linkStatus='active'}={}){
  const secret=prf(),vault=prepared?await TRoomCrypto.createPasskeyClientVault(secret):null;
  const user=f.seed({identityId,accountId,credentialId:crypto.randomUUID(),vault,status,linkStatus});
  return {...user,prf:secret};
}
async function unlock(client,secret){const prepared=await prepareAutomaticKeys(client.api,client.session,secret);client.session.keyBundle=prepared.keyBundle;const ledger=createEncryptedLedger(client.api,client.session);await ledger.unlock(secret.slice(),prepared.privateKey);return {prepared,ledger};}
test('ordinary owner login reuses T-Cloud vaults, encrypts existing generations, grants only approved family viewers and restores independent key envelopes',async()=>{
  const f=await automaticFixture();
  try{
    const owner=await person(f,'primary-admin','owner'),viewer=await person(f,'fixture-viewer','viewer');
    await person(f,'fixture-other','chiharu-admin');await person(f,'fixture-pending','viewer',{status:'pending'});await person(f,'fixture-revoked','viewer',{status:'revoked'});await person(f,'fixture-disabled-link','viewer',{linkStatus:'disabled'});
    const client=await f.client(owner),{ledger}=await unlock(client,owner.prf);
    const data=await ledger.load();assert.ok(data.data.categories.length>0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM household_datasets WHERE household_id='main' AND crypto_version=0").get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_grants').get().n,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_vaults').get().n,2);
    assert.equal(client.session.keyBundle.vault.keySource,'tcloud-member');
    const view=await f.client(viewer),opened=await unlock(view,viewer.prf);
    assert.deepEqual((await opened.ledger.load()).data,data.data);
    await assert.rejects(view.api('/keys/automatic/initialize',{keyId:crypto.randomUUID(),grants:[]}),e=>e.status===403);
    await assert.rejects(view.api('/keys/automatic/grants',{keyId:client.session.keyBundle.keyId,grants:[]}),e=>e.status===403);
    await assert.rejects(view.api('/encryption/migration',{}),e=>e.status===403);
    const forbidden=f.securityDb.prepare("SELECT credential_id FROM security_credentials WHERE identity_id='fixture-other'").get().credential_id;
    await assert.rejects(client.api('/keys/automatic/grants',{keyId:client.session.keyBundle.keyId,grants:[{credentialId:forbidden,serviceLinkId:'link-fixture-other-chiharu-admin',wrappedKey:'A'.repeat(512)}]}),e=>e.status===403);
    // A Household snapshot, without Security DB vault rows, must retain the
    // source/KDF marker and enough sealed material for browser decryption.
    const restored=new DatabaseSync(':memory:');
    try{
      for(const table of ['household_state','household_crypto_config','household_crypto_vaults','household_crypto_grants']){
        const schema=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;restored.exec(schema);
        for(const row of f.db.prepare(`SELECT * FROM ${table}`).all())restored.prepare(`INSERT INTO ${table} VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
      }
      const bundle=await keyBundle(d1(restored),{...viewer,householdId:'main'}),privateKey=await unlockAutomaticPrivate(viewer.prf,bundle.vault);
      const master=await unwrapMaster(privateKey,bundle.wrappedKey,keyScope(bundle));
      const recovered=await unwrapMaster(f.recovery.privateKey,bundle.recoveryWrappedKey,keyScope(bundle));
      assert.deepEqual(master,recovered);master.fill(0);recovered.fill(0);
    }finally{restored.close();}
    f.securityDb.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(viewer.credentialId);
    await assert.rejects(view.api('/keys/automatic'),e=>e.status===401);
    ledger.clear();opened.ledger.clear();
  }finally{f.close();}
});
test('unprepared existing passkeys prepare automatically; later viewers receive grants on the next ordinary owner use',async()=>{
  const f=await automaticFixture();
  try{
    const owner=await person(f,'primary-admin','owner',{prepared:false}),viewer=await person(f,'fixture-later','viewer',{prepared:false});
    const client=await f.client(owner),{prepared,ledger}=await unlock(client,owner.prf);
    assert.equal(client.session.keyBundle.vault.keySource,undefined);
    const view=await f.client(viewer);await assert.rejects(prepareAutomaticKeys(view.api,view.session,viewer.prf),e=>e.code==='key_pending');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_vaults').get().n,2);
    await shareAutomaticKeys(client.api,client.session,prepared.privateKey);
    const ready=await unlock(view,viewer.prf);assert.deepEqual((await ready.ledger.load()).data,(await ledger.load()).data);
    const before=f.db.prepare('SELECT * FROM household_crypto_vaults WHERE credential_id=?').get(owner.credentialId);
    await assert.rejects(client.api('/keys/automatic/vault',{vault:await createClientVault(owner.prf)}),e=>e.status===409);
    assert.deepEqual(f.db.prepare('SELECT * FROM household_crypto_vaults WHERE credential_id=?').get(owner.credentialId),before);
    await shareAutomaticKeys(client.api,client.session,prepared.privateKey);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_grants').get().n,2);
    ledger.clear();ready.ledger.clear();
  }finally{f.close();}
});
test('concurrent first owner logins converge on one recoverable master; failed batches leave no partial configuration',async()=>{
  const f=await automaticFixture();
  try{
    const owner=await person(f,'primary-admin','owner'),a=await f.client(owner),b=await f.client(owner);
    const batch=f.env.DB.batch.bind(f.env.DB);let injected=false;
    f.env.DB.batch=async statements=>{if(!injected){injected=true;throw new Error('synthetic unavailable');}return batch(statements);};
    await assert.rejects(prepareAutomaticKeys(a.api,a.session,owner.prf),e=>e.status===503);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,0);
    f.env.DB.batch=batch;
    const [one,two]=await Promise.all([prepareAutomaticKeys(a.api,a.session,owner.prf),prepareAutomaticKeys(b.api,b.session,owner.prf)]);
    assert.equal(one.keyBundle.keyId,two.keyBundle.keyId);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_config').get().n,1);
    const first=await unwrapMaster(one.privateKey,one.keyBundle.wrappedKey,keyScope(one.keyBundle)),second=await unwrapMaster(two.privateKey,two.keyBundle.wrappedKey,keyScope(two.keyBundle));assert.deepEqual(first,second);first.fill(0);second.fill(0);
  }finally{f.close();}
});
test('existing manually prepared Household vaults take precedence over T-Cloud vaults',async()=>{
  const f=await automaticFixture();
  try{
    const owner=await person(f,'primary-admin','owner'),vault=await createClientVault(owner.prf);
    await manageKeys(f.env.DB,'vault',{...owner,vault});
    const client=await f.client(owner),result=await prepareAutomaticKeys(client.api,client.session,owner.prf);
    assert.equal(result.keyBundle.vault.keySource,undefined);assert.equal(result.keyBundle.vault.publicKey.n,vault.publicKey.n);
  }finally{f.close();}
});
test('primary-admin PRF envelope supports automatic initialization and recovery; stale sessions cannot initialize vaults',async()=>{
  const f=await automaticFixture();
  try{
    const owner=await person(f,'primary-admin','owner',{prepared:false});
    const accountKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    const privateBytes=new Uint8Array(await crypto.subtle.exportKey('pkcs8',f.recovery.privateKey)),iv=crypto.getRandomValues(new Uint8Array(12));
    const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(ADMIN_WRAP_CONTEXT)},accountKey,privateBytes);privateBytes.fill(0);
    const encoded=v=>Buffer.from(v).toString('base64url');
    const envelope=await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey,{adminPrivateCipher:encoded(cipher),adminPrivateIv:encoded(iv)},owner.prf);
    f.securityDb.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES (?,'primary-admin',?,?,'admin_private_prf',?,?)").run(crypto.randomUUID(),owner.credentialId,owner.serviceLinkId,envelope.encryptedPayload,envelope.payloadIv);
    const client=await f.client(owner),first=await prepareAutomaticKeys(client.api,client.session,owner.prf);
    assert.equal(first.keyBundle.vault.keySource,'tcloud-admin');
    f.db.exec('DELETE FROM household_crypto_grants');
    const recovered=await prepareAutomaticKeys(client.api,client.session,owner.prf);assert.equal(recovered.keyBundle.keyId,first.keyBundle.keyId);
    const viewer=await person(f,'fixture-stale','viewer',{prepared:false}),stale=await f.client(viewer),vault=await createClientVault(viewer.prf);
    const now=Date.now;Date.now=()=>now()+360000;
    try{await assert.rejects(stale.api('/keys/automatic/vault',{vault}),e=>e.status===401&&e.code==='fresh_login_required');}
    finally{Date.now=now;}
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM household_crypto_vaults WHERE credential_id=?').get(viewer.credentialId).n,0);
  }finally{f.close();}
});
