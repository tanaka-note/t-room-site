import {HttpError, uuid} from './domain.js';
export const b64 = (v, min, max = min) => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v) && v.length % 4 !== 1;
const fail = (status, message) => { throw new HttpError(status, message); };
export function publicKey(value) {
  if(value?.kty!=='RSA'||!b64(value.n,512)||value.e!=='AQAB'||value.d)fail(400,'公開鍵を確認してください。');
  return {kty:'RSA',n:value.n,e:'AQAB',alg:'RSA-OAEP-256',key_ops:['encrypt'],ext:true};
}
export function vaultValue(row) {
  const value=JSON.parse(row.public_key_json);
  return {publicKey:publicKey(value),iv:row.iv,ciphertext:row.ciphertext,...(value.householdKeySource?{keySource:value.householdKeySource}:{})};
}
export const publicKeyFingerprint=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(publicKey(value))))),n=>n.toString(16).padStart(2,'0')).join('');
export async function keyConfig(db, householdId) {
  const row = await db.prepare('SELECT * FROM household_crypto_config WHERE household_id=?').bind(householdId).first();
  return row ? {householdId, keyId:row.key_id, recoveryWrappedKey:row.recovery_wrapped_key, recoveryPublicKey:JSON.parse(row.recovery_public_key)} : null;
}
export async function keyBundle(db, session) {
  const config = await keyConfig(db, session.householdId);
  if (!config) return null;
  const row = await db.prepare(`SELECT v.iv,v.ciphertext,v.public_key_json,g.wrapped_key FROM household_crypto_vaults v
    JOIN household_crypto_grants g ON g.credential_id=v.credential_id AND g.identity_id=v.identity_id
    WHERE v.credential_id=? AND v.identity_id=? AND g.service_link_id=? AND g.household_id=?`)
    .bind(session.credentialId, session.identityId, session.serviceLinkId, session.householdId).first();
  return row ? {...config,vault:vaultValue(row),wrappedKey:row.wrapped_key} : null;
}
// Internal Service Binding only. Security Center authenticates the actor, checks
// live credential/link state and requires fresh primary-admin auth for changes.
export async function manageKeys(db, action, input) {
  if (action === 'vault') {
    const v=input.vault;
    if (!v || Object.keys(v).sort().join(',') !== 'ciphertext,iv,publicKey' || !b64(v.iv,16) || !b64(v.ciphertext,1000,12000)
      || v.publicKey?.kty !== 'RSA' || !b64(v.publicKey.n,512) || v.publicKey.e !== 'AQAB' || v.publicKey.d) fail(400,'暗号化した利用者鍵を確認してください。');
    const publicKey=JSON.stringify({kty:'RSA',n:v.publicKey.n,e:'AQAB',alg:'RSA-OAEP-256',key_ops:['encrypt'],ext:true});
    await db.prepare('INSERT OR IGNORE INTO household_crypto_vaults VALUES(?,?,?,?,?)').bind(input.credentialId,input.identityId,publicKey,v.iv,v.ciphertext).run();
    const saved=await db.prepare('SELECT * FROM household_crypto_vaults WHERE credential_id=?').bind(input.credentialId).first();
    if(saved.identity_id!==input.identityId || saved.public_key_json!==publicKey || saved.iv!==v.iv || saved.ciphertext!==v.ciphertext) fail(409,'登録済みの鍵は置き換えられません。');
    return {ok:true};
  }
  if(action==='own') {
    const prepared=Boolean(await db.prepare('SELECT 1 FROM household_crypto_vaults WHERE credential_id=? AND identity_id=?').bind(input.credentialId,input.identityId).first());
    const targets=[];
    for(const link of input.links) {
      const account=await db.prepare('SELECT * FROM household_accounts WHERE id=? AND is_active=1').bind(link.serviceAccountId).first();
      if(account)targets.push({serviceLinkId:link.serviceLinkId,displayName:account.display_name,ready:Boolean(await keyBundle(db,{...input,...link,householdId:account.household_id}))});
    }
    return {prepared,ready:targets.length>0 && targets.every(t=>t.ready),targets};
  }
  const account=await db.prepare('SELECT * FROM household_accounts WHERE id=? AND is_active=1').bind(input.serviceAccountId).first();
  if(!account)fail(403,'対象の家計を確認できません。');
  const householdId=account.household_id;
  if(action==='admin') {
    const members=[];
    for(const m of input.members) {
      const target=await db.prepare('SELECT household_id FROM household_accounts WHERE id=? AND is_active=1').bind(m.serviceAccountId).first();
      if(target?.household_id!==householdId)continue;
      const vault=await db.prepare('SELECT public_key_json FROM household_crypto_vaults WHERE credential_id=? AND identity_id=?').bind(m.credentialId,m.identityId).first();
      if(vault)members.push({...m,publicKey:publicKey(JSON.parse(vault.public_key_json)),granted:Boolean(await keyBundle(db,{...m,householdId}))});
    }
    return {householdId,config:await keyConfig(db,householdId),members};
  }
  if(action==='initialize') {
    uuid(input.keyId);
    if(!b64(input.recoveryWrappedKey,512) || input.recoveryPublicKey?.kty!=='RSA' || input.recoveryPublicKey.d)fail(400,'復旧用の暗号鍵を確認してください。');
    const publicKey=JSON.stringify(input.recoveryPublicKey);
    await db.prepare('INSERT OR IGNORE INTO household_crypto_config VALUES(?,?,?,?)').bind(householdId,input.keyId,input.recoveryWrappedKey,publicKey).run();
    const config=await keyConfig(db,householdId);
    if(config.keyId!==input.keyId || config.recoveryWrappedKey!==input.recoveryWrappedKey || JSON.stringify(config.recoveryPublicKey)!==publicKey)fail(409,'家計の鍵は既に準備されています。');
    return {ok:true};
  }
  if(action==='grant') {
    const config=await keyConfig(db,householdId);
    if(!config || config.keyId!==input.keyId || !b64(input.wrappedKey,512))fail(409,'委譲対象の鍵を確認してください。');
    const vault=await db.prepare('SELECT identity_id FROM household_crypto_vaults WHERE credential_id=?').bind(input.credentialId).first();
    if(vault?.identity_id!==input.identityId)fail(403,'利用者鍵の準備を先に完了してください。');
    await db.prepare('INSERT OR IGNORE INTO household_crypto_grants VALUES(?,?,?,?,?)').bind(householdId,input.credentialId,input.identityId,input.serviceLinkId,input.wrappedKey).run();
    const row=await db.prepare('SELECT identity_id,wrapped_key FROM household_crypto_grants WHERE household_id=? AND credential_id=? AND service_link_id=?').bind(householdId,input.credentialId,input.serviceLinkId).first();
    if(row.identity_id!==input.identityId || row.wrapped_key!==input.wrappedKey)fail(409,'承認済みの鍵は置き換えられません。');
    return {ok:true};
  }
  fail(404,'指定された操作が見つかりません。');
}
