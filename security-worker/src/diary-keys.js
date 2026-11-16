import {diaryEncryptionOrigin} from '../../diary-worker/e2ee/origin.mjs';
import { b64,encode,fingerprint,verifyDirectory,verifySigned,validateEnvelope,validatePublicKey,recoveryWrappedBytes,unb64 } from '../../diary-worker/e2ee/crypto.mjs';
import { canRead } from '../../diary-worker/e2ee/policy.mjs';
import { verifyRecord } from '../../diary-worker/e2ee/record.mjs';
import {publicTrustPackage} from '../../diary-worker/e2ee/setup.mjs';
import {validateSealedTrust} from '../../diary-worker/e2ee/trust.mjs';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const equal=(a,b)=>b64(encode(a))===b64(encode(b));
function scopeRecord(scope,households) {
  const household=Object.keys(households).find(h=>scope.startsWith(h+':'));
  if(!household)fail(400,'InvalidScope');
  const [kind,...ids]=scope.slice(household.length+1).split(':');
  const state={published:'published',drafts:'draft',preferences:'preferences',trash:'trash',investment:'investment'}[kind];
  if(!state||state==='preferences'&&ids.length!==1||state==='trash'&&!ids.length||['published','draft','investment'].includes(state)&&ids.length)fail(400,'InvalidScope');
  return {household,state,author:ids[0]||'',retainedFor:state==='trash'?ids:[]};
}
export const diaryKeysEnabled=env=>String(env.DIARY_ENCRYPTION_ENABLED||'false')==='true';
export function diaryAuthenticationOrigins(env,service) {
  if(service!=='diary'||!diaryKeysEnabled(env)||!env.DIARY_ENCRYPTION_ORIGIN)return [];
  return [diaryEncryptionOrigin(env)];
}
export async function diaryRecipientId(credentialId,serviceLinkId) {
  return b64(await crypto.subtle.digest('SHA-256',encode({protocol:'T-lain diary recipient',credentialId,serviceLinkId})));
}
async function liveLinks(env,identityId,credentialId) {
  return (await env.DB.prepare(`SELECT l.id,l.service_account_id accountId FROM security_service_links l JOIN security_credentials c ON c.identity_id=l.identity_id JOIN security_identities i ON i.id=l.identity_id WHERE l.identity_id=? AND c.credential_id=? AND l.service='diary' AND l.status='active' AND c.status='active' AND i.status='active'`).bind(identityId,credentialId).all()).results;
}
async function activeAccountClaims(env,accountId) {
  const claims=await env.DIARY_AUTH.describeEncryptionAccount({accountId});
  if(claims&&claims.accountId!==accountId)fail(403,'DiaryAccountUnavailable');
  return claims?.active?claims:null;
}
async function accountClaims(env,accountId) {
  const claims=await activeAccountClaims(env,accountId);
  if(!claims)fail(403,'DiaryAccountUnavailable');
  return claims;
}
async function config(env) {
  const row=await env.DB.prepare('SELECT * FROM security_diary_key_config WHERE id=1').first();
  return row?{generation:row.generation,anchor:JSON.parse(row.anchor_json),directory:JSON.parse(row.directory_json),recoveryEnvelope:JSON.parse(row.recovery_json)}:null;
}

// Public trust is endorsed by the same Security Center authentication which
// authorizes the service handoff. It is never bootstrapped from Diary data.
export async function diaryLoginTrust(env,identityId,credentialId) {
  if(!diaryKeysEnabled(env)||(await liveLinks(env,identityId,credentialId)).length===0)return null;
  const current=await config(env);if(!current)return null;
  await verifyDirectory(current.directory,current.anchor,current.generation);
  return publicTrustPackage(current);
}

async function storeTrust(env,recipientId,packet) {
  validateSealedTrust(packet);const current=await config(env);
  if(packet.generation!==current?.generation)fail(409,'DiaryTrustGenerationConflict');
  const saved=await env.DB.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').bind(recipientId).first();
  if(!saved)fail(409,'DiaryVaultRequired');
  const vault=JSON.parse(saved.vault_json);
  if(vault.trust?.generation>packet.generation)fail(409,'DiaryTrustGenerationConflict');
  if(vault.trust?.generation!==packet.generation)await env.DB.prepare('UPDATE security_diary_key_vaults SET vault_json=? WHERE recipient_id=? AND vault_json=?').bind(JSON.stringify({...vault,trust:packet}),recipientId,saved.vault_json).run();
  const result=await env.DB.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=?').bind(recipientId).first();
  const trust=JSON.parse(result.vault_json).trust;
  if(trust?.generation!==packet.generation)fail(409,'DiaryTrustGenerationConflict');
  return trust;
}

export async function diaryAutomaticManagement(env,input,validate,audit=async()=>{}) {
  await diaryAutomaticVault(env,input,validate);
  const claims=await accountClaims(env,input.serviceAccountId);
  if(input.identityId!=='primary-admin'||!claims.isGlobalOwner)fail(403,'AccessDenied');
  const path=input.path;
  if(!['/own','/vault','/admin','/config','/recovery-records'].includes(path?.split('?')[0]))fail(404,'UnknownDiaryAutomaticRoute');
  const method=input.value===undefined?'GET':'POST';
  if(!((method==='GET'&&['/own','/admin','/recovery-records'].includes(path.split('?')[0]))||(method==='POST'&&['/vault','/config'].includes(path))))fail(405,'MethodDenied');
  const response=await handleDiaryKeys('/api/diary'+path,new Request('https://security.internal/security/api/diary'+path,{method,...(method==='POST'?{body:JSON.stringify(input.value)}:{})}),env,
    {identityId:input.identityId,credentialId:input.credentialId,authenticatedAt:Date.parse(input.startedAt)/1000},
    {readJson:async(request,limit)=>{const text=await request.text();if(new TextEncoder().encode(text).length>limit)fail(413,'RequestTooLarge');return JSON.parse(text);},json:Response.json,audit});
  return response.json();
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

async function writerReadiness(env,current) {
  const rows=(await env.DB.prepare(`SELECT DISTINCT l.service_account_id account_id FROM security_service_links l
    JOIN security_identities i ON i.id=l.identity_id JOIN security_credentials c ON c.identity_id=l.identity_id
    WHERE l.service='diary' AND l.status='active' AND i.status='active' AND c.status='active'`).all()).results;
  const missingAccountIds=[];
  for(const row of rows) {
    const claims=await activeAccountClaims(env,row.account_id);if(!claims)continue;
    let ready=false;
    for(const member of current?.directory.value.members.filter(m=>m.accountId===row.account_id)||[]) {
      const prepared=await env.DB.prepare(`SELECT 1 ready FROM security_diary_key_vaults v JOIN security_diary_key_grants g ON g.recipient_id=v.recipient_id AND g.service_link_id=v.service_link_id WHERE v.recipient_id=? AND v.account_id=? AND g.generation=?`).bind(member.credentialId,row.account_id,current.generation).first();
      if(prepared&&(await liveLinks(env,member.identityId,member.webAuthnCredentialId)).some(link=>link.id===member.serviceLinkId&&link.accountId===row.account_id)){ready=true;break;}
    }
    if(!ready)missingAccountIds.push(row.account_id);
  }
  return {ready:missingAccountIds.length===0,missingAccountIds:missingAccountIds.sort()};
}

// Diary calls this only after checking its signed service cookie. Like
// Household's automatic setup, revalidate the active link/epoch at Security.
// This prepares the caller's immutable vault; it grants no data access.
export async function diaryAutomaticVault(env,input,validate,audit=async()=>{}) {
  if(!diaryKeysEnabled(env))fail(404,'DiaryEncryptionDisabled');
  if(input?.service!=='diary'||input.authMethod!=='passkey'||!(await validate(env,{...input,sessionEpoch:input.passkeySessionEpoch})).valid)fail(403,'DiaryAutomaticSessionInvalid');
  const link=(await liveLinks(env,input.identityId,input.credentialId)).find(link=>link.id===input.serviceLinkId&&link.accountId===input.serviceAccountId);
  if(!link)fail(403,'DiaryAutomaticSessionInvalid');
  await accountClaims(env,link.accountId);
  const recipientId=await diaryRecipientId(input.credentialId,link.id);
  if(input.preparation!==undefined) {
    const age=Date.now()-Date.parse(input.startedAt);
    if(!Number.isFinite(age)||age<0||age>300000)fail(428,'RecentAuthenticationRequired');
    if(input.preparation.recipientId!==recipientId)fail(403,'DiaryAutomaticRecipientMismatch');
    if(exact(input.preparation,['recipientId','trust'])) {
      await storeTrust(env,recipientId,input.preparation.trust);
      await audit('diary_trust_prepared',input.identityId);
    }else {
    if(!exact(input.preparation,['recipientId','vault']))fail(400,'InvalidDiaryVault');
    if(encode(input.preparation).length>20000)fail(413,'InvalidDiaryVault');
    const request=new Request('https://security.internal/security/api/diary/vault',{method:'POST',body:JSON.stringify({serviceLinkId:link.id,vault:input.preparation.vault})});
    try {
      await handleDiaryKeys('/api/diary/vault',request,env,{identityId:input.identityId,credentialId:input.credentialId,authenticatedAt:Date.parse(input.startedAt)/1000},
        {readJson:request=>request.json(),json:(value,status=200)=>Response.json(value,{status}),audit});
    }catch(error){if(error.status!==409||error.message!=='DiaryVaultImmutable')throw error;}
    }
  }
  const row=await env.DB.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=? AND identity_id=? AND credential_id=? AND service_link_id=? AND account_id=?').bind(recipientId,input.identityId,input.credentialId,link.id,link.accountId).first();
  return {recipientId,accountId:link.accountId,webAuthnCredentialId:input.credentialId,vault:row?JSON.parse(row.vault_json):null};
}

// Caller supplies live Security sessions and its existing mutation/reauth gates.
export async function handleDiaryKeys(path,request,env,actor,{readJson,json,audit}) {
  if(!diaryKeysEnabled(env))fail(404,'DiaryEncryptionDisabled');
  const links=await liveLinks(env,actor.identityId,actor.credentialId);
  if(!links.length)fail(403,'DiaryLinkRequired');
  if(path==='/api/diary/own'&&request.method==='GET') {
    const entries=[];
    for(const link of links){const recipientId=await diaryRecipientId(actor.credentialId,link.id);const vault=await env.DB.prepare('SELECT recipient_id,vault_json FROM security_diary_key_vaults WHERE recipient_id=?').bind(recipientId).first();entries.push({...link,recipientId,prepared:Boolean(vault),...(vault?{trust:JSON.parse(vault.vault_json).trust}:{} )});}
    return json({links:entries});
  }
  if(!Number.isFinite(actor.authenticatedAt)||Date.now()/1000-actor.authenticatedAt>300)fail(428,'RecentAuthenticationRequired');
  if(path==='/api/diary/trust'&&request.method==='POST') {
    const body=await readJson(request,16000),link=links.find(link=>link.id===body.serviceLinkId);
    if(!link||!exact(body,['serviceLinkId','trust']))fail(403,'DiaryAutomaticRecipientMismatch');
    const trust=await storeTrust(env,await diaryRecipientId(actor.credentialId,link.id),body.trust);
    await audit('diary_trust_prepared',actor.identityId);return json({trust});
  }
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
    const members=[];for(const row of rows){const claims=await activeAccountClaims(env,row.account_id);if(!claims)continue;members.push({identityId:row.identity_id,serviceLinkId:row.service_link_id,credentialId:row.recipient_id,webAuthnCredentialId:row.credential_id,...claims,...JSON.parse(row.vault_json),privateEnvelope:undefined});}
    const households=await env.DIARY_AUTH.encryptionHouseholds();
    return json({config:current,recoveryPublicKey:cloud?.publicKeyJwk||null,adminEnvelope,members,households,
      writerReadiness:await writerReadiness(env,current),scopeAccounts:(await env.DIARY_AUTH.encryptionScopeAccounts()).filter(Boolean),retainedScopes:await env.DIARY_AUTH.encryptionRetainedScopes(),rollout:await env.DIARY_AUTH.encryptionRollout()});
  }
  if(path==='/api/diary/control'&&request.method==='POST') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    let link,claims;
    for(const candidate of links){const live=await activeAccountClaims(env,candidate.accountId);if(live?.isGlobalOwner){link=candidate;claims=live;break;}}
    if(!link)fail(403,'AccessDenied');
    const body=await readJson(request,20000);if(!exact(body,['expectedGeneration','next','evidence']))fail(400,'InvalidRolloutRequest');
    if(body.next==='encrypted'&&!(await writerReadiness(env,current)).ready)fail(409,'DiaryWriterPreparationRequired');
    const actorClaims={...claims,credentialId:await diaryRecipientId(actor.credentialId,link.id),reauthenticatedAt:actor.authenticatedAt};
    const directory=await verifyDirectory(current.directory,current.anchor,current.generation);
    const result=await env.DIARY_AUTH.transitionEncryption({...body,actor:actorClaims,directory});
    await audit('diary_rollout_changed',actor.identityId);return json(result);
  }
  if(path==='/api/diary/investment'&&['GET','POST'].includes(request.method)) {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    let operator;
    for(const link of links){const claims=await activeAccountClaims(env,link.accountId);if(claims?.isGlobalOwner&&claims.canViewInvestment){operator={...claims,credentialId:await diaryRecipientId(actor.credentialId,link.id),reauthenticatedAt:actor.authenticatedAt};break;}}
    if(!operator)fail(403,'AccessDenied');
    const directory=await verifyDirectory(current.directory,current.anchor,current.generation);
    if(request.method==='GET')return json(await env.DIARY_AUTH.encryptionInvestmentRecord({actor:operator,directory}));
    if((await diaryKeyBundle(env,{identityId:actor.identityId,credentialId:actor.credentialId,serviceLinkId:links.find(link=>link.accountId===operator.accountId).id,serviceAccountId:operator.accountId}))?.rekeyRequired)fail(423,'RekeyRequired');
    const body=await readJson(request,2_000_000);if(!exact(body,['proposal']))fail(400,'InvalidInvestmentRequest');
    const result=await env.DIARY_AUTH.saveEncryptedInvestment({actor:operator,directory,proposal:body.proposal});
    await audit('diary_investment_updated',actor.identityId);return json(result);
  }
  if(path==='/api/diary/maintenance/backup'&&request.method==='POST') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    return json(await env.DIARY_AUTH.createEncryptionCheckpoint({directoryGeneration:current.generation}));
  }
  if(path==='/api/diary/maintenance/checkpoint'&&request.method==='GET') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    const query=new URL(request.url).searchParams;
    return json(await env.DIARY_AUTH.readEncryptionCheckpoint({directoryGeneration:current.generation,checkpoint:query.get('checkpoint'),part:query.has('part')?Number(query.get('part')):undefined}));
  }
  if(path==='/api/diary/maintenance/build'&&request.method==='GET')return json(await env.DIARY_AUTH.encryptionBuild());
  if(path==='/api/diary/maintenance/inventory'&&request.method==='GET') {
    const q=new URL(request.url).searchParams;
    return json(await env.DIARY_AUTH.encryptionMaintenanceInventory({kind:q.get('kind')||'records',after:q.get('after')||'',limit:20}));
  }
  if(path==='/api/diary/maintenance/signing-vault'&&request.method==='POST') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    for(const link of links) {
      const claims=await activeAccountClaims(env,link.accountId);if(!claims?.isGlobalOwner)continue;
      const recipientId=await diaryRecipientId(actor.credentialId,link.id);
      const member=current.directory.value.members.find(member=>member.credentialId===recipientId&&member.accountId===link.accountId);
      const row=await env.DB.prepare('SELECT vault_json FROM security_diary_key_vaults WHERE recipient_id=? AND account_id=? AND credential_id=?').bind(recipientId,link.accountId,actor.credentialId).first();
      if(member&&row){const grant=await env.DB.prepare('SELECT grants_json FROM security_diary_key_grants WHERE recipient_id=? AND service_link_id=? AND generation=?').bind(recipientId,link.id,current.generation).first();if(grant)return json({recipientId,accountId:link.accountId,vault:JSON.parse(row.vault_json),grants:JSON.parse(grant.grants_json)});}
    }
    fail(403,'AccessDenied');
  }
  if(path==='/api/diary/migration/inventory'&&request.method==='GET') {
    const q=new URL(request.url).searchParams;
    return json(await env.DIARY_AUTH.encryptionMigrationInventory({table:q.get('table'),after:Number(q.get('after')||0),limit:20}));
  }
  if(path==='/api/diary/migration/import'&&request.method==='POST') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    const body=await readJson(request,2_000_000);if(!exact(body,['kind','rows','expectedGeneration']))fail(400,'InvalidMigrationBatch');
    const directory=await verifyDirectory(current.directory,current.anchor,current.generation);
    return json(await env.DIARY_AUTH.importEncryptionMigration({...body,directory}));
  }
  if(path==='/api/diary/rotation/status'&&request.method==='GET')return json(await env.DIARY_AUTH.encryptionRotationStatus());
  if(path==='/api/diary/rotation/inventory'&&request.method==='GET') {
    const q=new URL(request.url).searchParams;
    return json(await env.DIARY_AUTH.encryptionRotationInventory({after:q.get('after')||'',kind:q.get('kind')||'records',limit:20}));
  }
  if(path==='/api/diary/rotation/stage'&&request.method==='POST') {
    const current=await config(env);if(!current)fail(409,'EncryptionPreparationRequired');
    const body=await readJson(request,2_000_000);if(!exact(body,['kind','rows']))fail(400,'InvalidRotationBatch');
    return json(await env.DIARY_AUTH.stageEncryptionRotation({...body,anchor:current.anchor}));
  }
  if(path==='/api/diary/rotation/commit'&&request.method==='POST') {
    const body=await readJson(request,200);if(!exact(body,['manifestDigest']))fail(400,'InvalidRotationRequest');
    const result=await env.DIARY_AUTH.commitEncryptionRotation(body);
    await audit('diary_rekey_committed',actor.identityId);return json(result);
  }
  if(['/api/diary/config','/api/diary/rotation/begin'].includes(path)&&request.method==='POST') {
    const rotationBegin=path.endsWith('/rotation/begin');
    const input=await readJson(request,rotationBegin?25_000_000:4_000_000),current=await config(env);
    if(rotationBegin&&(!current||!exact(input,['configuration','manifest'])))fail(400,'InvalidRotationRequest');
    const body=rotationBegin?input.configuration:input;
    const rotation=current&&!rotationBegin?await env.DIARY_AUTH.encryptionRotationStatus():null;
    const rotated=Boolean(rotation?.status==='committed'&&equal(rotation.configuration,body)&&rotation.manifest.value.sourceGeneration===current.generation);
    const rekey=rotationBegin||rotated;
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
    const operatorMembers=(await Promise.all(links.map(l=>activeAccountClaims(env,l.accountId)))).filter(Boolean);
    if(!operatorMembers.some(m=>m.isGlobalOwner))fail(403,'AccessDenied');
    if(!directory.members.some(m=>m.identityId===actor.identityId&&operatorMembers.some(c=>c.isGlobalOwner&&c.accountId===m.accountId)))fail(403,'DiaryOwnerRequired');
    if(!rekey&&current?.directory.value.members.some(old=>!directory.members.some(member=>member.credentialId===old.credentialId&&equal(member.publicKey,old.publicKey)&&equal(member.signPublicKey,old.signPublicKey))))fail(409,'HistoricalSigningKeyRequired');
    if(!rekey&&current?.directory.value.members.some(old=>!directory.members.some(member=>member.credentialId===old.credentialId&&member.accountId===old.accountId&&member.canManageEntries===old.canManageEntries&&equal([...member.households].sort(),[...old.households].sort())&&old.scopes.every(scope=>member.scopes.includes(scope)))))fail(409,'RekeyRequired');
    const recipientIds=directory.members.map(m=>m.credentialId);
    if(!exact(body.grants,recipientIds)||!exact(body.recordGrants,recipientIds))fail(400,'InvalidGrantRecipients');
    // Rebuild supplemental grants from the complete current ciphertext inventory.
    // Otherwise a later generation can silently lose access granted on recovery.
    const recoveryRecords=new Map();
    if(current&&!retry&&!rekey){let after='';do {
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
    if(rotationBegin) {
      if(retry)fail(409,'DiaryKeyGenerationConflict');
      return json(await env.DIARY_AUTH.beginEncryptionRotation({configuration:body,manifest:input.manifest,anchor,currentDirectory:await verifyDirectory(current.directory,anchor,current.generation)}));
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
