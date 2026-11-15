// Only called through the Household Service Binding after its signed session
// has been verified. Reusing an encrypted private-key envelope grants no Cloud
// role, folder access or new Household service link.
export async function householdAutomaticContext(env,input,validate) {
  if(input?.service!=='household'||!(await validate(env,{...input,sessionEpoch:input.passkeySessionEpoch})).valid)throw new Error('HouseholdAutomaticSessionInvalid');
  const own=await env.HOUSEHOLD_AUTH.describeKeyScope({serviceAccountId:input.serviceAccountId});
  if(!own?.valid||own.role!==input.role)throw new Error('HouseholdAutomaticScopeInvalid');
  const cloud=await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
  const recoveryPublicKey=cloud?.initialized?cloud.publicKeyJwk:null;
  const rows=(await env.DB.prepare(`SELECT c.credential_id AS credentialId,c.identity_id AS identityId,l.id AS serviceLinkId,l.service_account_id AS serviceAccountId,i.is_security_admin AS isAdmin,
      v.public_key_jwk AS publicKeyJson,v.encrypted_payload AS encryptedPayload,v.payload_iv AS payloadIv,
      e.encrypted_payload AS adminPayload,e.payload_iv AS adminIv
    FROM security_service_links l JOIN security_credentials c ON c.identity_id=l.identity_id
    JOIN security_identities i ON i.id=l.identity_id
    LEFT JOIN security_tcloud_client_vaults v ON v.credential_id=c.credential_id AND v.identity_id=c.identity_id
    LEFT JOIN security_tcloud_key_envelopes e ON e.credential_id=c.credential_id AND e.identity_id=c.identity_id AND e.envelope_type='admin_private_prf'
    WHERE l.service='household' AND l.status='active' AND c.status='active' AND i.status='active'
      AND (?=1 OR (c.credential_id=? AND l.id=?)) ORDER BY c.credential_id,l.id LIMIT 1001`)
    .bind(own.role==='owner'?1:0,input.credentialId,input.serviceLinkId).all()).results;
  if(rows.length>1000)throw new Error('HouseholdAutomaticRecipientLimit');
  const scopes=new Map([[input.serviceAccountId,own]]),members=[],seen=new Set();
  for(const row of rows){
    if(!scopes.has(row.serviceAccountId))scopes.set(row.serviceAccountId,await env.HOUSEHOLD_AUTH.describeKeyScope({serviceAccountId:row.serviceAccountId}));
    const scope=scopes.get(row.serviceAccountId),id=`${row.credentialId}:${row.serviceLinkId}`;
    if(!scope?.valid||scope.householdId!==own.householdId||seen.has(id))continue;seen.add(id);
    let source=null;
    if(row.identityId==='primary-admin'&&row.isAdmin===1&&row.adminPayload&&recoveryPublicKey)source={keySource:'tcloud-admin',publicKey:recoveryPublicKey,iv:row.adminIv,ciphertext:row.adminPayload};
    else if(row.publicKeyJson&&row.encryptedPayload)source={keySource:'tcloud-member',publicKey:JSON.parse(row.publicKeyJson),iv:row.payloadIv,ciphertext:row.encryptedPayload};
    members.push({identityId:row.identityId,credentialId:row.credentialId,serviceLinkId:row.serviceLinkId,serviceAccountId:row.serviceAccountId,source});
  }
  if(!members.some(m=>m.credentialId===input.credentialId&&m.serviceLinkId===input.serviceLinkId&&m.identityId===input.identityId))throw new Error('HouseholdAutomaticSessionInvalid');
  return {householdId:own.householdId,role:own.role,recoveryPublicKey,members};
}
