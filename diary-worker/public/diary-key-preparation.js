import {createVault,unlockVault} from './crypto/e2ee/crypto.mjs';
import {TRUST_PIN,resolveTrust,sealTrust,openTrust,sameTrust} from './crypto/e2ee/trust.mjs';
import {prepareKeyConfiguration,publicTrustPackage} from './crypto/e2ee/setup.mjs';
import {unlockCentralRecovery} from './crypto/e2ee/tcloud-recovery.mjs';

function pinnedTrust() {
  return typeof localStorage==='undefined'?null:JSON.parse(localStorage.getItem(TRUST_PIN)||'null');
}
function remember(trust) {
  if(typeof localStorage!=='undefined')localStorage.setItem(TRUST_PIN,JSON.stringify(trust));
}
const PENDING=TRUST_PIN+'-automatic-pending';
const pending=()=>typeof localStorage==='undefined'?null:JSON.parse(localStorage.getItem(PENDING)||'null');
const managementApi=api=>(path,body)=>api('/encryption/manage'+path,body===undefined?{}:{method:'POST',body});
async function resumeConfiguration(api,session,check) {
  if(!session.isGlobalOwner||!pending())return null;
  const configuration=pending(),manage=managementApi(api),status=await manage('/admin');check();
  if(status.config&&JSON.stringify(status.config.directory)===JSON.stringify(configuration.directory)&&JSON.stringify(status.config.recoveryEnvelope)===JSON.stringify(configuration.recoveryEnvelope)) {
    // Both are written with all grants in one Security transaction.
  }else {
    if((status.config?.generation||0)!==configuration.expectedGeneration)throw new Error('前回の鍵設定の結果を照合できません。管理者の復旧操作で確認してください。');
    await manage('/config',configuration);check();
  }
  const trust=await publicTrustPackage(configuration);remember(trust);
  localStorage.removeItem(PENDING);return trust;
}

async function approvePreparedRecipients(api,session,authentication,trust,check) {
  if(!session.isGlobalOwner)return trust;
  const management=managementApi(api);
  const own=await management('/own');check();
  for(const link of own.links.filter(link=>!link.prepared)) {
    const vault=await createVault(authentication.prfOutput,link.recipientId);check();
    await management('/vault',{serviceLinkId:link.id,vault});check();
  }
  const status=await management('/admin');check();
  const old=status.config?.directory.value.members||[];
  if(status.config&&status.members.length===old.length&&status.members.every(member=>old.some(previous=>previous.credentialId===member.credentialId&&previous.canManageEntries===member.canManageEntries&&JSON.stringify(previous.households)===JSON.stringify(member.households))))return trust;
  const privateKey=await unlockCentralRecovery(authentication.prfOutput,status.adminEnvelope);check();
  const recoveryRecords=[];let after='';
  if(status.config)do {
    const page=await management('/recovery-records'+(after?'?after='+encodeURIComponent(after):''));check();
    recoveryRecords.push(...page.records);after=page.nextCursor;
    if(recoveryRecords.length>5000)throw new Error('RecoveryRecordLimit');
  }while(after);
  const configuration=await prepareKeyConfiguration({status,recoveryPrivateKey:privateKey,trustedAnchor:trust?.anchor,recoveryRecords});check();
  // Preserve the generated anchor before attempting a first configuration write.
  // The server accepts the exact generation retry after a lost response.
  const next=await publicTrustPackage(configuration);
  if(typeof localStorage!=='undefined')localStorage.setItem(PENDING,JSON.stringify(configuration));
  remember(next);
  await management('/config',configuration);check();
  if(typeof localStorage!=='undefined')localStorage.removeItem(PENDING);
  return next;
}

// Called by the normal Diary passkey login. The caller owns and clears PRF;
// only the sealed vault and public keys cross the service API.
export async function prepareDiaryKeys(...args) {
  try{return await prepareKeys(...args);}
  catch(error) {
    if(error.message==='RekeyRequired')throw Object.assign(new Error('パスキーの失効または権限変更に伴う鍵更新が必要です。管理者の復旧操作を行ってください。'),{code:'RekeyRequired'});
    if(['DiaryTrustChanged','DiaryTrustRollback','InvalidPasskeyTrust','InvalidPublicTrust','InvalidEnvelope'].includes(error.message)||error.name==='OperationError')throw Object.assign(new Error('日記の鍵設定の一致を確認できません。管理者へ復旧を依頼してください。'),{code:'DiaryTrustInvalid'});
    throw error;
  }
}
async function prepareKeys(api,session,authentication,check=()=>{}) {
  if(!(authentication?.prfOutput instanceof Uint8Array)||authentication.prfOutput.length!==32)throw new Error('暗号化の利用準備にはPRF対応のパスキーが必要です。');
  const assertOwn=value=>{
    check();
    if(value.accountId!==session.encryption.accountId||value.webAuthnCredentialId!==authentication.credentialId||typeof value.recipientId!=='string')throw Object.assign(new Error('ログイン状態が変わりました。パスキーでログインし直してください。'),{sessionChanged:true});
    return value;
  };
  let info=assertOwn(await api('/encryption/prepare'));
  if(!info.vault) {
    const vault=await createVault(authentication.prfOutput,info.recipientId);check();
    info=assertOwn(await api('/encryption/prepare',{method:'POST',body:{recipientId:info.recipientId,vault}}));
  }
  // Check the existing vault too. A race or response loss must never cause
  // replacement of an already prepared key, nor accept an unusable vault.
  await unlockVault(authentication.prfOutput,info.recipientId,info.vault);check();
  let bootstrap=authentication.handoff?.diaryTrust||authentication.verified?.diaryTrust;
  if(authentication.handoff?.diaryTrust&&authentication.verified?.diaryTrust)await sameTrust(authentication.verified.diaryTrust,authentication.handoff.diaryTrust);
  const resumed=await resumeConfiguration(api,session,check);
  if(resumed){if(bootstrap)await sameTrust(bootstrap,resumed);bootstrap=resumed;}
  let trust;
  if(info.vault.trust||bootstrap||pinnedTrust())trust=await resolveTrust({prf:authentication.prfOutput,recipientId:info.recipientId,sealed:info.vault.trust,bootstrap,pinned:pinnedTrust()});
  check();trust=await approvePreparedRecipients(api,session,authentication,trust,check);check();
  if(trust) {
    if(!info.vault.trust||info.vault.trust.generation!==trust.minimumGeneration) {
      const packet=await sealTrust(authentication.prfOutput,info.recipientId,trust);check();
      info=assertOwn(await api('/encryption/prepare',{method:'POST',body:{recipientId:info.recipientId,trust:packet}}));
    }
    if(!info.vault.trust)throw new Error('DiaryTrustNotSaved');
    await sameTrust(trust,await openTrust(authentication.prfOutput,info.recipientId,info.vault.trust));check();remember(trust);
  }else if(session.encryption.enabled)throw new Error('日記の鍵の準備を待っています。管理者の次の利用後にログインし直してください。');
  return {prepared:true};
}
