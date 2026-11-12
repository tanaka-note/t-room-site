import {HttpError,uuid} from './domain.js';
import {b64,keyConfig,keyBundle,manageKeys,publicKey,vaultValue,publicKeyFingerprint} from './keys.js';
const fail=(status,message,code='key_setup_failed')=>{throw new HttpError(status,message,code);};
async function context(env,session){
  const info=await env.SECURITY.getHouseholdAutomaticContext({...session,service:'household'});
  if(info?.householdId!==session.householdId||info.role!==session.role||!Array.isArray(info.members)||info.members.length>1000)fail(503,'暗号鍵の利用準備を確認できません。');
  const db=env.DB,recipients=[];
  for(const member of info.members){
    const account=await db.prepare('SELECT household_id FROM household_accounts WHERE id=? AND is_active=1').bind(member.serviceAccountId).first();
    if(account?.household_id!==session.householdId)continue;
    const source=member.source;
    if(source){
      if(!['tcloud-admin','tcloud-member'].includes(source.keySource)||!b64(source.iv,16)||!b64(source.ciphertext,1000,12000))fail(503,'既存の暗号鍵情報を確認できません。');
      const key=JSON.stringify({...publicKey(source.publicKey),householdKeySource:source.keySource});
      // Existing Household keys, including manually prepared ones, stay immutable.
      await db.prepare('INSERT OR IGNORE INTO household_crypto_vaults VALUES(?,?,?,?,?)').bind(member.credentialId,member.identityId,key,source.iv,source.ciphertext).run();
    }
    const row=await db.prepare('SELECT * FROM household_crypto_vaults WHERE credential_id=? AND identity_id=?').bind(member.credentialId,member.identityId).first();
    if(row)recipients.push({...member,source:undefined,publicKey:vaultValue(row).publicKey,granted:Boolean(await keyBundle(db,{...member,householdId:session.householdId}))});
  }
  const own=await db.prepare('SELECT * FROM household_crypto_vaults WHERE credential_id=? AND identity_id=?').bind(session.credentialId,session.identityId).first();
  return {householdId:session.householdId,role:session.role,recoveryPublicKey:info.recoveryPublicKey?publicKey(info.recoveryPublicKey):null,
    config:await keyConfig(db,session.householdId),keyBundle:await keyBundle(db,session),vault:own?vaultValue(own):null,
    recipients:session.role==='owner'?recipients:[]};
}
const fresh=session=>{const age=Date.now()-Date.parse(session.startedAt);if(!Number.isFinite(age)||age<0||age>300000)fail(401,'パスキーでログインし直してください。','fresh_login_required');};
export async function automaticKeysApi(request,env,path,session,readJson,audit){
  const info=await context(env,session);
  if(path==='/api/keys/automatic'&&request.method==='GET')return Response.json(info,{headers:{'Cache-Control':'no-store'}});
  if(request.method!=='POST')fail(404,'指定された操作が見つかりません。');
  const body=await readJson(request),db=env.DB;
  if(path==='/api/keys/automatic/vault'){
    fresh(session);
    if(Object.keys(body).join(',')!=='vault')fail(400,'利用者鍵の形式を確認してください。');
    // Public clients can prepare only their own PRF-wrapped Household key.
    await manageKeys(db,'vault',{identityId:session.identityId,credentialId:session.credentialId,vault:body.vault});
    await audit(env,request,session,'household_vault_prepared_auto');
  }else if(['/api/keys/automatic/initialize','/api/keys/automatic/grants'].includes(path)){
    if(session.role!=='owner')fail(403,'このアカウントは閲覧専用です。');
    const initialize=path.endsWith('/initialize');
    if(initialize)fresh(session);
    const allowed=initialize?['keyId','recoveryWrappedKey','recoveryKeyFingerprint','grants']:['keyId','grants'];
    if(Object.keys(body).some(k=>!allowed.includes(k))||!Array.isArray(body.grants)||body.grants.length>1000)fail(400,'暗号化した鍵の形式を確認してください。');
    uuid(body.keyId);
    const config=await keyConfig(db,session.householdId);
    if(config&&config.keyId!==body.keyId)fail(409,'別の画面で暗号鍵が準備されました。','key_conflict');
    if(!initialize&&!config)fail(409,'暗号鍵の準備を確認し直してください。','key_conflict');
    const statements=[],seen=new Set();
    for(const grant of body.grants){
      if(!grant||Object.keys(grant).sort().join(',')!=='credentialId,serviceLinkId,wrappedKey'||!b64(grant.wrappedKey,512))fail(400,'暗号化した委譲鍵を確認してください。');
      const member=info.recipients.find(m=>m.credentialId===grant.credentialId&&m.serviceLinkId===grant.serviceLinkId),id=`${grant.credentialId}:${grant.serviceLinkId}`;
      if(!member||seen.has(id))fail(403,'委譲対象の家計簿連携を確認できません。');seen.add(id);
      // Never replace an already granted key, including during concurrent logins.
      const prior=await db.prepare('SELECT identity_id,wrapped_key FROM household_crypto_grants WHERE household_id=? AND credential_id=? AND service_link_id=?').bind(session.householdId,member.credentialId,member.serviceLinkId).first();
      if(prior){if(prior.identity_id!==member.identityId)fail(409,'委譲鍵が変更されています。','key_conflict');continue;}
      statements.push(db.prepare('INSERT OR IGNORE INTO household_crypto_grants VALUES(?,?,?,?,?)').bind(session.householdId,member.credentialId,member.identityId,member.serviceLinkId,grant.wrappedKey));
    }
    if(initialize&&!config){
      if(!info.recoveryPublicKey||!b64(body.recoveryWrappedKey,512)||body.recoveryKeyFingerprint!==await publicKeyFingerprint(info.recoveryPublicKey)
        ||!seen.has(`${session.credentialId}:${session.serviceLinkId}`))fail(409,'復旧用鍵と本人の委譲鍵を確認し直してください。','key_conflict');
      statements.unshift(db.prepare('INSERT INTO household_crypto_config VALUES(?,?,?,?)').bind(session.householdId,body.keyId,body.recoveryWrappedKey,JSON.stringify(info.recoveryPublicKey)));
    }
    try{if(statements.length)await db.batch(statements);}catch(error){if(/UNIQUE constraint/.test(String(error?.message)))fail(409,'別の画面で暗号鍵が準備されました。','key_conflict');throw error;}
    await audit(env,request,session,initialize?'household_key_initialized_auto':'household_key_granted_auto');
  }else fail(404,'指定された操作が見つかりません。');
  return Response.json(await context(env,session),{headers:{'Cache-Control':'no-store'}});
}
