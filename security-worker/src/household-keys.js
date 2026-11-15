// Authentication and live link checks stay in Security Center; encrypted key
// envelopes live beside the ledger so a D1 backup contains its recovery keys.
export async function handleHouseholdKeys(path,request,env,actor,{HttpError,readJson,json,audit}) {
  const rpc=async(action,input)=>{
    const result=await env.HOUSEHOLD_AUTH.cryptoKeys(action,input);
    if(result?.error)throw new HttpError(result.status,result.error);
    return result;
  };
  const links=async()=> (await env.DB.prepare("SELECT id AS serviceLinkId,service_account_id AS serviceAccountId FROM security_service_links WHERE identity_id=? AND service='household' AND status='active'").bind(actor.identityId).all()).results;
  if(path==='/api/household/own'&&request.method==='GET')return json(await rpc('own',{identityId:actor.identityId,credentialId:actor.credentialId,links:await links()}));
  if(path==='/api/household/vault'&&request.method==='POST') {
    if(Date.now()/1000-actor.authenticatedAt>300)throw new HttpError(401,'もう一度パスキーで本人確認してください。');
    if(!(await links()).length)throw new HttpError(403,'家計簿への連携を先に追加してください。');
    const vault=await readJson(request,15000);
    const value=await rpc('vault',{identityId:actor.identityId,credentialId:actor.credentialId,vault});
    await audit('household_vault_prepared',actor.identityId);return json(value);
  }
  if(actor.identityId!=='primary-admin')throw new HttpError(403,'鍵の管理は第一管理者が行います。');
  const adminEnvelope=async()=>env.DB.prepare("SELECT encrypted_payload AS encryptedPayload,payload_iv AS payloadIv FROM security_tcloud_key_envelopes WHERE identity_id='primary-admin' AND credential_id=? AND envelope_type='admin_private_prf'").bind(actor.credentialId).first();
  if(path==='/api/household/recovery'&&request.method==='GET')return json({adminEnvelope:await adminEnvelope()});
  const target=async(serviceLinkId,credentialId)=>{
    const row=await env.DB.prepare(`SELECT l.id AS serviceLinkId,l.identity_id AS identityId,l.service_account_id AS serviceAccountId
      FROM security_service_links l JOIN security_identities i ON i.id=l.identity_id
      WHERE l.id=? AND l.service='household' AND l.status='active' AND i.status='active'`).bind(serviceLinkId).first();
    if(!row)throw new HttpError(403,'対象の家計簿連携を確認できません。');
    if(credentialId && !await env.DB.prepare("SELECT 1 FROM security_credentials WHERE credential_id=? AND identity_id=? AND status='active'").bind(credentialId,row.identityId).first())throw new HttpError(403,'対象のパスキーを確認できません。');
    return {...row,...(credentialId?{credentialId}:{})};
  };
  if(path==='/api/household/admin'&&request.method==='GET') {
    const selected=await target(new URL(request.url).searchParams.get('serviceLinkId'));
    const members=(await env.DB.prepare(`SELECT c.credential_id AS credentialId,l.id AS serviceLinkId,l.identity_id AS identityId,l.service_account_id AS serviceAccountId
      FROM security_service_links l JOIN security_credentials c ON c.identity_id=l.identity_id JOIN security_identities i ON i.id=l.identity_id
      WHERE l.service='household' AND l.status='active' AND c.status='active' AND i.status='active'`).all()).results;
    const state=await rpc('admin',{serviceAccountId:selected.serviceAccountId,members});
    const cloud=await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
    return json({...state,recoveryPublicKey:cloud?.initialized?cloud.publicKeyJwk:null,adminEnvelope:await adminEnvelope()});
  }
  if(path==='/api/household/initialize'&&request.method==='POST') {
    const value=await readJson(request,4000);
    if(Object.keys(value).sort().join(',')!=='keyId,recoveryWrappedKey,serviceLinkId')throw new HttpError(400,'復旧用の暗号鍵を確認してください。');
    const selected=await target(value.serviceLinkId),cloud=await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
    if(!cloud?.initialized||!cloud.publicKeyJwk)throw new HttpError(409,'T-Cloud管理者鍵を先に準備してください。');
    const result=await rpc('initialize',{serviceAccountId:selected.serviceAccountId,keyId:value.keyId,recoveryWrappedKey:value.recoveryWrappedKey,recoveryPublicKey:cloud.publicKeyJwk});
    await audit('household_key_initialized',selected.identityId);return json(result);
  }
  if(path==='/api/household/grant'&&request.method==='POST') {
    const value=await readJson(request,4000);
    if(Object.keys(value).sort().join(',')!=='credentialId,keyId,serviceLinkId,wrappedKey')throw new HttpError(400,'委譲する暗号鍵を確認してください。');
    const selected=await target(value.serviceLinkId,value.credentialId);
    const result=await rpc('grant',{...selected,keyId:value.keyId,wrappedKey:value.wrappedKey});
    await audit('household_key_granted',selected.identityId);return json(result);
  }
  throw new HttpError(404,'指定された操作が見つかりません。');
}
