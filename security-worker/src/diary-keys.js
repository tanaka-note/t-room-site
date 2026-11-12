import { b64,encode,fingerprint,verifyDirectory,verifySigned,validateEnvelope,validatePublicKey,recoveryWrappedBytes,unb64 } from '../../diary-worker/e2ee/crypto.mjs';
import { canRead } from '../../diary-worker/e2ee/policy.mjs';
import { verifyRecord } from '../../diary-worker/e2ee/record.mjs';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const equal=(a,b)=>b64(encode(a))===b64(encode(b));
function scopeRecord(scope,households) {
  const household=Object.keys(households).find(h=>scope.startsWith(h+':'));
  if(!household)fail(400,'InvalidScope');
  const [kind,...ids]=scope.slice(household.length+1).split(':');
  const state={published:'published',drafts:'draft',preferences:'preferences',trash:'trash'}[kind];
  if(!state||state==='preferences'&&ids.length!==1||state==='trash'&&!ids.length||['published','draft'].includes(state)&&ids.length)fail(400,'InvalidScope');
  return {household,state,author:ids[0]||'',retainedFor:state==='trash'?ids:[]};
}
export const diaryKeysEnabled=env=>String(env.DIARY_ENCRYPTION_ENABLED||'false')==='true';
export async function diaryRecipientId(credentialId,serviceLinkId) {
  return b64(await crypto.subtle.digest('SHA-256',encode({protocol:'T-lain diary recipient',credentialId,serviceLinkId})));
}
async function liveLinks(env,identityId,credentialId) {
  return (await env.DB.prepare(`SELECT l.id,l.service_account_id accountId FROM security_service_links l JOIN security_credentials c ON c.identity_id=l.identity_id JOIN security_identities i ON i.id=l.identity_id WHERE l.identity_id=? AND c.credential_id=? AND l.service='diary' AND l.status='active' AND c.status='active' AND i.status='active'`).bind(identityId,credentialId).all()).results;
}
async function accountClaims(env,accountId) {
  const claims=await env.DIARY_AUTH.describeEncryptionAccount({accountId});
  if(!claims||claims.accountId!==accountId)fail(403,'DiaryAccountUnavailable');
  return claims;
}
async function config(env) {
  const row=await env.DB.prepare('SELECT * FROM security_diary_key_config WHERE id=1').first();
  return row?{generation:row.generation,anchor:JSON.parse(row.anchor_json),directory:JSON.parse(row.directory_json),recoveryEnvelope:JSON.parse(row.recovery_json)}:null;
}

export async function diaryKeyBundle(env,input) {
  if(!diaryKeysEnabled(env))return null;
  const link=(await liveLinks(env,input.identityId,input.credentialId)).find(l=>l.id===input.serviceLinkId&&l.accountId===input.serviceAccountId);
  if(!link)return null;
  const recipientId=await diaryRecipientId(input.credentialId,link.id),current=await config(env);
  if(!current)return null;
  const directory=await verifyDirectory(current.directory,current.anchor,current.generation);
  const row=await env.DB.prepare(`SELECT v.vault_json,g.grants_json,g.record_grants_json FROM security_diary_key_vaults v JOIN security_diary_key_grants g ON g.recipient_id=v.recipient_id AND g.service_link_id=v.service_link_id WHERE v.recipient_id=? AND v.identity_id=? AND v.credential_id=? AND v.service_link_id=? AND v.account_id=? AND g.generation=?`).bind(recipientId,input.identityId,input.credentialId,link.id,link.accountId,current.generation).first();
  const member=directory.members.find(m=>m.credentialId===recipientId&&m.accountId===link.accountId);
  if(!row||!member)return null;
  // Loss of an approved credential/link requires rekeying before new writes.
  // Inactive historical signing certificates are retained for verification.
  let rekeyRequired=false;
  const active=(await env.DB.prepare(`SELECT v.recipient_id FROM security_diary_key_vaults v JOIN security_credentials c ON c.credential_id=v.credential_id AND c.identity_id=v.identity_id JOIN security_service_links l ON l.id=v.service_link_id AND l.identity_id=v.identity_id AND l.service='diary' AND l.service_account_id=v.account_id JOIN security_identities i ON i.id=v.identity_id WHERE c.status='active' AND l.status='active' AND i.status='active'`).all()).results;
  const ids=new Set(active.map(v=>v.recipient_id));
  if(!equal(directory.households,await env.DIARY_AUTH.encryptionHouseholds()))rekeyRequired=true;
  for(const m of directory.members)if(m.active!==false) {
    if(!ids.has(m.credentialId)){rekeyRequired=true;continue;}
    try {
      const claims=await accountClaims(env,m.accountId);
      if(!claims.active||m.canManageEntries!==claims.canManageEntries||!equal([...m.households].sort(),[...claims.households].sort())||m.scopes.some(scope=>!canRead(claims,scopeRecord(scope,directory.households))))rekeyRequired=true;
    }catch{rekeyRequired=true;}
  }
  return {...current,recipientId,webAuthnCredentialId:input.credentialId,serviceLinkId:link.id,accountId:link.accountId,vault:JSON.parse(row.vault_json),grants:JSON.parse(row.grants_json),recordGrants:JSON.parse(row.record_grants_json),rekeyRequired};
}

// Caller supplies live Security sessions and its existing mutation/reauth gates.
export async function handleDiaryKeys(path,request,env,actor,{readJson,json,audit}) {
  if(!diaryKeysEnabled(env))fail(404,'DiaryEncryptionDisabled');
  const links=await liveLinks(env,actor.identityId,actor.credentialId);
  if(!links.length)fail(403,'DiaryLinkRequired');
  if(path==='/api/diary/own'&&request.method==='GET') {
    const entries=[];
    for(const link of links){const recipientId=await diaryRecipientId(actor.credentialId,link.id);const vault=await env.DB.prepare('SELECT recipient_id FROM security_diary_key_vaults WHERE recipient_id=?').bind(recipientId).first();entries.push({...link,recipientId,prepared:Boolean(vault)});}
    return json({links:entries});
  }
  if(!Number.isFinite(actor.authenticatedAt)||Date.now()/1000-actor.authenticatedAt>300)fail(428,'RecentAuthenticationRequired');
  if(path==='/api/diary/vault'&&request.method==='POST') {
    const body=await readJson(request,20000),link=links.find(l=>l.id===body.serviceLinkId),vault=body.vault;
    if(!link||!exact(body,['serviceLinkId','vault'])||!exact(vault,['publicKey','signPublicKey','privateEnvelope']))fail(400,'InvalidDiaryVault');
    validateEnvelope(vault.privateEnvelope);
    validatePublicKey(vault.publicKey,'recipient');validatePublicKey(vault.signPublicKey,'signing');
    await crypto.subtle.importKey('jwk',vault.publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
    await crypto.subtle.importKey('jwk',vault.signPublicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    const recipientId=await diaryRecipientId(actor.credentialId,link.id);
    await env.DB.prepare('INSERT INTO security_diary_key_vaults VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(recipientId,actor.credentialId,actor.identityId,link.id,link.accountId,JSON.stringify(vault)).run();
    const saved=await env.DB.prepare('SELECT * FROM security_diary_key_vaults WHERE recipient_id=?').bind(recipientId).first();
    if(saved.identity_id!==actor.identityId||saved.service_link_id!==link.id||!equal(JSON.parse(saved.vault_json),vault))fail(409,'DiaryVaultImmutable');
    await audit('diary_vault_prepared',actor.identityId);return json({ok:true,recipientId});
  }
  if(actor.identityId!=='primary-admin')fail(403,'AccessDenied');
  if(path==='/api/diary/recovery-records'&&request.method==='GET')return json(await env.DIARY_AUTH.encryptionRecoveryRecords({after:new URL(request.url).searchParams.get('after')||'',limit:20}));
  if(path==='/api/diary/admin'&&request.method==='GET') {
    const current=await config(env),cloud=await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
    const adminEnvelope=await env.DB.prepare("SELECT encrypted_payload encryptedPayload,payload_iv payloadIv FROM security_tcloud_key_envelopes WHERE identity_id='primary-admin' AND credential_id=? AND envelope_type='admin_private_prf'").bind(actor.credentialId).first();
    const rows=(await env.DB.prepare(`SELECT v.* FROM security_diary_key_vaults v JOIN security_credentials c ON c.credential_id=v.credential_id JOIN security_identities i ON i.id=v.identity_id JOIN security_service_links l ON l.id=v.service_link_id WHERE c.status='active' AND i.status='active' AND l.status='active'`).all()).results;
    const members=[];for(const row of rows){const claims=await accountClaims(env,row.account_id);members.push({identityId:row.identity_id,serviceLinkId:row.service_link_id,credentialId:row.recipient_id,webAuthnCredentialId:row.credential_id,...claims,...JSON.parse(row.vault_json),privateEnvelope:undefined});}
    const households=await env.DIARY_AUTH.encryptionHouseholds();
    return json({config:current,recoveryPublicKey:cloud?.publicKeyJwk||null,adminEnvelope,members,households});
  }
  if(path==='/api/diary/control'&&request.method==='POST') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    const link=links.find(l=>l.accountId===current.directory.value.households[Object.keys(current.directory.value.households)[0]].owner);
    if(!link)fail(403,'AccessDenied');
    const claims=await accountClaims(env,link.accountId);if(!claims.isGlobalOwner)fail(403,'AccessDenied');
    const body=await readJson(request,20000);if(!exact(body,['expectedGeneration','next','evidence']))fail(400,'InvalidRolloutRequest');
    const actorClaims={...claims,credentialId:await diaryRecipientId(actor.credentialId,link.id),reauthenticatedAt:actor.authenticatedAt};
    const directory=await verifyDirectory(current.directory,current.anchor,current.generation);
    const result=await env.DIARY_AUTH.transitionEncryption({...body,actor:actorClaims,directory});
    await audit('diary_rollout_changed',actor.identityId);return json(result);
  }
  if(path==='/api/diary/config'&&request.method==='POST') {
    const body=await readJson(request,4_000_000),current=await config(env);
    if(!exact(body,['expectedGeneration','anchor','directory','recoveryEnvelope','grants','recordGrants'])||!Number.isSafeInteger(body.expectedGeneration)||body.expectedGeneration<0)fail(409,'DiaryKeyGenerationConflict');
    const retry=Boolean(current&&body.expectedGeneration===current.generation-1&&equal(body.anchor,current.anchor)&&equal(body.directory,current.directory)&&equal(body.recoveryEnvelope,current.recoveryEnvelope));
    if(!retry&&body.expectedGeneration!==(current?.generation||0))fail(409,'DiaryKeyGenerationConflict');
    const anchor=current?.anchor||body.anchor;
    if(current&&!equal(anchor,body.anchor))fail(409,'DiaryAuthorityImmutable');
    const directory=await verifyDirectory(body.directory,anchor,body.expectedGeneration+1);
    if(directory.generation!==body.expectedGeneration+1)fail(409,'DiaryKeyGenerationConflict');
    const cloud=await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
    if(!cloud?.publicKeyJwk||directory.recoveryFingerprint!==await fingerprint(cloud.publicKeyJwk)||body.recoveryEnvelope?.recoveryFingerprint!==directory.recoveryFingerprint||body.recoveryEnvelope?.authority!==await fingerprint(anchor)||body.recoveryEnvelope?.generation!==directory.generation)fail(400,'DiaryRecoveryMismatch');
    validateEnvelope(body.recoveryEnvelope.envelope);
    if(!exact(body.recoveryEnvelope,['version','generation','authority','recoveryFingerprint','envelope','wrappedKey'])||body.recoveryEnvelope.version!==1||unb64(body.recoveryEnvelope.wrappedKey,684).length!==recoveryWrappedBytes(directory.recoveryPublicKey))fail(400,'DiaryRecoveryMismatch');
    if(!equal(directory.households,await env.DIARY_AUTH.encryptionHouseholds()))fail(403,'DiaryHouseholdsMismatch');
    const operatorMembers=await Promise.all(links.map(l=>accountClaims(env,l.accountId)));
    if(!operatorMembers.some(m=>m.isGlobalOwner))fail(403,'AccessDenied');
    if(!directory.members.some(m=>m.identityId===actor.identityId&&operatorMembers.some(c=>c.isGlobalOwner&&c.accountId===m.accountId)))fail(403,'DiaryOwnerRequired');
    if(current?.directory.value.members.some(old=>!directory.members.some(member=>member.credentialId===old.credentialId&&equal(member.publicKey,old.publicKey)&&equal(member.signPublicKey,old.signPublicKey))))fail(409,'HistoricalSigningKeyRequired');
    if(current?.directory.value.members.some(old=>!directory.members.some(member=>member.credentialId===old.credentialId&&member.accountId===old.accountId&&member.canManageEntries===old.canManageEntries&&equal([...member.households].sort(),[...old.households].sort())&&old.scopes.every(scope=>member.scopes.includes(scope)))))fail(409,'RekeyRequired');
    const recipientIds=directory.members.map(m=>m.credentialId);
    if(!exact(body.grants,recipientIds)||!exact(body.recordGrants,recipientIds))fail(400,'InvalidGrantRecipients');
    // Rebuild supplemental grants from the complete current ciphertext inventory.
    // Otherwise a later generation can silently lose access granted on recovery.
    const recoveryRecords=new Map();
    if(current&&!retry){let after='';do {
      const page=await env.DIARY_AUTH.encryptionRecoveryRecords({after,limit:20});
      for(const record of page.records){await verifyRecord(record,current.directory.value);if(recoveryRecords.has(record.id))fail(409,'DiaryRecoveryInventoryChanged');recoveryRecords.set(record.id,record);}
      if(recoveryRecords.size>5000||page.nextCursor&&page.nextCursor<=after)fail(409,'DiaryRecoveryInventoryChanged');
      after=page.nextCursor;
    }while(after);}
    const statements=[];
    for(const member of directory.members) {
      if(member.active===false)fail(409,"RekeyRequired");
      const row=await env.DB.prepare('SELECT * FROM security_diary_key_vaults WHERE recipient_id=?').bind(member.credentialId).first();
      if(!row||member.accountId!==row.account_id||member.serviceLinkId!==row.service_link_id||member.identityId!==row.identity_id||member.webAuthnCredentialId!==row.credential_id||!(await liveLinks(env,row.identity_id,row.credential_id)).some(link=>link.id===row.service_link_id&&link.accountId===row.account_id))fail(403,'DiaryRecipientMismatch');
      const vault=JSON.parse(row.vault_json),claims=await accountClaims(env,row.account_id);
      if(!equal(member.publicKey,vault.publicKey)||!equal(member.signPublicKey,vault.signPublicKey)||member.canManageEntries!==claims.canManageEntries||!equal(member.households,claims.households))fail(403,'DiaryRecipientMismatch');
      for(const scope of member.scopes)if(!canRead(claims,scopeRecord(scope,directory.households)))fail(403,'DiaryScopeDenied');
      const grants=body.grants[member.credentialId];if(!Array.isArray(grants)||grants.length!==member.scopes.length)fail(400,'IncompleteGrants');
      const validateGrant=async(packet,record=false)=>{
        const grant=await verifySigned(packet,anchor);
        if(!exact(packet,['value','signature'])||!exact(grant,['version','household','scope','epoch','accountId','credentialId','fingerprint','directoryGeneration','wrapped',...(record?['id','revision','kind']:[])])||grant.version!==1||unb64(packet.signature,100).length!==64||unb64(grant.wrapped,512).length!==384||grant.credentialId!==member.credentialId||grant.accountId!==member.accountId||grant.directoryGeneration!==directory.generation||grant.fingerprint!==member.fingerprint||!member.scopes.includes(grant.scope)||directory.epochs[grant.scope]!==grant.epoch||grant.household!==scopeRecord(grant.scope,directory.households).household)fail(400,'InvalidGrant');
        return grant;
      };
      const scopes=new Set();for(const packet of grants){const grant=await validateGrant(packet);if(scopes.has(grant.scope))fail(400,'InvalidGrant');scopes.add(grant.scope);}
      const recordGrants=body.recordGrants[member.credentialId]||[];if(!Array.isArray(recordGrants)||recordGrants.length>5000)fail(400,'InvalidRecordGrants');
      const recordIds=new Set();for(const packet of recordGrants){const grant=await validateGrant(packet,true);const id=`${grant.id}:${grant.revision}`;if(grant.kind!=='record'||!Number.isSafeInteger(grant.revision)||grant.revision<1||!(/^[1-9][0-9]{0,15}$/.test(grant.id))||recordIds.has(id))fail(400,'InvalidRecordGrant');recordIds.add(id);}
      if(!retry){const expected=[...recoveryRecords.values()].filter(record=>member.scopes.includes(record.scope)&&!record.keyBox[member.credentialId]);if(expected.length!==recordGrants.length||expected.some(record=>!recordGrants.some(packet=>packet.value.id===record.id&&packet.value.revision===record.revision&&packet.value.household===record.household&&packet.value.scope===record.scope&&packet.value.epoch===record.epoch)))fail(409,'IncompleteRecordGrants');}
      if(retry){const saved=await env.DB.prepare('SELECT grants_json,record_grants_json FROM security_diary_key_grants WHERE recipient_id=? AND service_link_id=? AND generation=?').bind(member.credentialId,row.service_link_id,directory.generation).first();if(!saved||!equal(JSON.parse(saved.grants_json),grants)||!equal(JSON.parse(saved.record_grants_json),recordGrants))fail(409,'DiaryKeyGenerationConflict');}
      statements.push(env.DB.prepare('INSERT INTO security_diary_key_grants VALUES(?,?,?,?,?)').bind(member.credentialId,row.service_link_id,directory.generation,JSON.stringify(grants),JSON.stringify(recordGrants)));
    }
    if(retry)return json({ok:true,generation:directory.generation});
    const update=current?env.DB.prepare('UPDATE security_diary_key_config SET generation=?,anchor_json=?,directory_json=?,recovery_json=? WHERE id=1 AND generation=?').bind(directory.generation,JSON.stringify(anchor),JSON.stringify(body.directory),JSON.stringify(body.recoveryEnvelope),body.expectedGeneration):env.DB.prepare('INSERT INTO security_diary_key_config VALUES(1,?,?,?,?)').bind(directory.generation,JSON.stringify(anchor),JSON.stringify(body.directory),JSON.stringify(body.recoveryEnvelope));
    // Duplicate generations fail the transaction, preserving all existing grants.
    await env.DB.batch([update,...statements]);
    const saved=await config(env);if(saved.generation!==directory.generation||!equal(saved.directory,body.directory))fail(409,'DiaryKeyGenerationConflict');
    await audit('diary_keys_configured',actor.identityId);return json({ok:true,generation:directory.generation});
  }
  fail(404,'UnknownDiaryKeyRoute');
}
