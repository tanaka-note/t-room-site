import {createVault,unlockVault} from './crypto/e2ee/crypto.mjs';
import {TRUST_PIN,resolveTrust,sealTrust,openTrust,sameTrust,sealPendingConfiguration,openPendingConfiguration,rememberTrustFloor,checkTrustFloor} from './crypto/e2ee/trust.mjs';
import {prepareKeyConfiguration,publicTrustPackage,scopeDefinitions} from './crypto/e2ee/setup.mjs';
import {unlockCentralRecovery} from './crypto/e2ee/tcloud-recovery.mjs';
import {rememberPreparedVault} from './crypto/e2ee/session.mjs';
import {readDiaryStartup} from './crypto/e2ee/startup-read.mjs';

function pinnedTrust() {
  return typeof localStorage==='undefined'?null:JSON.parse(localStorage.getItem(TRUST_PIN)||'null');
}
async function remember(trust) {
  return rememberTrustFloor(trust,typeof localStorage==='undefined'?undefined:localStorage);
}
const PENDING=TRUST_PIN+'-automatic-pending';
const pending=()=>typeof localStorage==='undefined'?null:JSON.parse(localStorage.getItem(PENDING)||'null');
const managementApi=api=>(path,body)=>api('/encryption/manage'+path,body===undefined?{}:{method:'POST',body});
async function resumeConfiguration(api,session,authentication,recipientId,check) {
  if(!session.isGlobalOwner||!pending())return null;
  const configuration=await openPendingConfiguration(authentication.prfOutput,recipientId,pending()),manage=managementApi(api),status=await manage('/admin');check();
  if(status.config&&JSON.stringify(status.config.directory)===JSON.stringify(configuration.directory)&&JSON.stringify(status.config.recoveryEnvelope)===JSON.stringify(configuration.recoveryEnvelope)) {
    // Both are written with all grants in one Security transaction.
  }else {
    if((status.config?.generation||0)!==configuration.expectedGeneration)throw new Error('前回の鍵設定の結果を照合できません。管理者の復旧操作で確認してください。');
    await manage('/config',configuration);check();
  }
  const trust=await publicTrustPackage(configuration);await remember(trust);
  localStorage.removeItem(PENDING);return trust;
}

async function approvePreparedRecipients(api,session,authentication,recipientId,trust,check) {
  if(!session.isGlobalOwner)return trust;
  const management=managementApi(api);
  // These reads are independent for an already prepared owner. If preparing
  // a vault changes the recipient inventory, obtain a new admin view afterward.
  const [own,initialStatus]=await Promise.all([management('/own'),management('/admin')]);check();
  let changed=false;
  for(const link of own.links.filter(link=>!link.prepared)) {
    const vault=await createVault(authentication.prfOutput,link.recipientId);check();
    await management('/vault',{serviceLinkId:link.id,vault});check();
    changed=true;
  }
  const status=changed?await management('/admin'):initialStatus;check();
  // The ordinary addition-only configuration checks also apply on resume.
  // A newer directory invalidates old continuations and forces the migration
  // controller to recheck the frozen source/ciphertext and restore checkpoint.
  const old=status.config?.directory.value.members||[];
  if(status.config?.directory.value.delegationPublicKey) {
    if(old.some(member=>member.credentialId===recipientId&&member.active!==false))return trust;
    throw Object.assign(new Error('本人確認が完了しました。日記の利用準備を管理者が確認します。'),{code:'DiaryKeyPreparationPending'});
  }
  if(status.config&&scopeDefinitions(status.households,[...status.members,...(status.scopeAccounts||[])],status.retainedScopes||[]).every(row=>status.config.directory.value.epochs[row.scope])&&status.members.length===old.length&&status.members.every(member=>old.some(previous=>previous.credentialId===member.credentialId&&previous.canManageEntries===member.canManageEntries&&JSON.stringify(previous.households)===JSON.stringify(member.households))))return trust;
  if(!status.adminEnvelope) {
    const ownRecipient=old.some(member=>member.credentialId===recipientId&&member.active!==false);
    if(ownRecipient&&trust&&session.encryption.phase==='encrypted')return trust;
    throw Object.assign(new Error('本人確認が完了しました。日記の利用準備を管理者が確認します。'),{code:'DiaryKeyPreparationPending'});
  }
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
  if(typeof localStorage!=='undefined')localStorage.setItem(PENDING,JSON.stringify(await sealPendingConfiguration(authentication.prfOutput,recipientId,configuration)));
  await remember(next);
  await management('/config',configuration);check();
  if(typeof localStorage!=='undefined')localStorage.removeItem(PENDING);
  return next;
}

export function diaryMigrationMessage(progress) {
  if(progress.phase==='complete')return '日記を開いています…';
  const subject=progress.kind==='media'?'写真情報':progress.kind==='records'?'日記・設定':'データ';
  const count=Number.isSafeInteger(progress.completed)&&Number.isSafeInteger(progress.total)?`（${subject} ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}件）`:'';
  const labels={reading:'移行する内容を確認しています','reading-saved':'保存済みの暗号化データを取得しています','verifying-source':'保存済みデータを元の内容と照合しています',writing:'暗号化した内容を保存しています',backup:'復元確認用のバックアップを作成しています',restoring:'バックアップを端末内に復元しています',comparing:'保存内容を照合しています',decrypting:'復元した内容を検証しています'};
  return (labels[progress.phase]||'日記の暗号化を準備しています')+count+'… この画面を開いたままお待ちください。';
}

// Called by the normal Diary passkey login. The caller owns and clears PRF;
// only the sealed vault and public keys cross the service API.
export async function prepareDiaryKeys(...args) {
  if(args[2])args[2].diaryPreparedKeys=null;
  const preventUpdate=event=>event.preventDefault();
  globalThis.document?.addEventListener('troom:before-auto-update',preventUpdate);
  const run=()=>prepareKeys(...args);
  try{return args[1]?.isGlobalOwner&&globalThis.navigator?.locks?await navigator.locks.request('tlain-diary-owner-setup',run):await run();}
  catch(error) {
    if(args[2]?.diaryMigrationStarted||args[1]?.encryption?.phase==='migrating')error.migrationPending=true;
    if(error.message==='RekeyRequired')throw Object.assign(new Error('パスキーの失効または権限変更に伴う鍵更新が必要です。管理者の復旧操作を行ってください。'),{code:'RekeyRequired',migrationPending:error.migrationPending});
    if(['DiaryTrustChanged','DiaryTrustRollback','InvalidPasskeyTrust','InvalidPublicTrust','InvalidEnvelope'].includes(error.message)||error.name==='OperationError')throw Object.assign(new Error('日記の鍵設定の一致を確認できません。管理者へ復旧を依頼してください。'),{code:'DiaryTrustInvalid',migrationPending:error.migrationPending});
    throw error;
  }finally{globalThis.document?.removeEventListener('troom:before-auto-update',preventUpdate);}
}
async function readPreparedProfile(api,session,authentication,check) {
  if(session.role!=='user'||session.isGlobalOwner||!session.keySession?.id
    ||!session.encryption.enabled||session.encryption.phase!=='encrypted')return null;
  let result;
  try {
    result=await api('/encryption/profile');
  }catch(error){
    // A newly linked recipient may still need automatic vault preparation.
    check();
    if(error.status===409)return null;
    throw error;
  }
  check();
  const {profile,rollout}=result;
  if(result.protocol!==session.encryption.protocol||rollout?.generation!==session.encryption.generation
    ||profile?.household!==session.activeHouseholdId||profile?.actor?.accountId!==session.encryption.accountId
    ||profile?.webAuthnCredentialId!==authentication.credentialId) {
    throw Object.assign(new Error('ログイン状態が変わりました。パスキーでログインし直してください。'),{sessionChanged:true});
  }
  if(rollout?.phase!=='encrypted'||result.rekeyRequired||!profile.vault?.trust
    ||profile.vault.trust.generation!==result.minimumGeneration)return null;
  return result;
}

async function prepareKeys(api,session,authentication,check=()=>{},onProgress=()=>{},{reusePreparedProfile=false}={}) {
  if(!(authentication?.prfOutput instanceof Uint8Array)||authentication.prfOutput.length!==32)throw new Error('暗号化の利用準備にはPRF対応のパスキーが必要です。');
  if (reusePreparedProfile && session.encryption.phase === 'encrypted') {
    const request = api;
    api = (path, options = {}) => {
      if (options.method === 'POST') return request(path, options);
      return readDiaryStartup(signal => {
        check();
        return request(path, {...options, signal});
      });
    };
  }
  const assertOwn=value=>{
    check();
    if(value.accountId!==session.encryption.accountId||value.webAuthnCredentialId!==authentication.credentialId||typeof value.recipientId!=='string')throw Object.assign(new Error('ログイン状態が変わりました。パスキーでログインし直してください。'),{sessionChanged:true});
    return value;
  };
  let startupProfile=reusePreparedProfile?await readPreparedProfile(api,session,authentication,check):null;
  let info;
  if(startupProfile) {
    const {profile}=startupProfile;
    info=assertOwn({
      accountId:profile.actor.accountId,
      webAuthnCredentialId:profile.webAuthnCredentialId,
      recipientId:profile.actor.credentialId,
      vault:profile.vault
    });
  }else info=assertOwn(await api('/encryption/prepare'));
  if(!info.vault) {
    const vault=await createVault(authentication.prfOutput,info.recipientId);check();
    info=assertOwn(await api('/encryption/prepare',{method:'POST',body:{recipientId:info.recipientId,vault}}));
  }
  // Check the existing vault too. A race or response loss must never cause
  // replacement of an already prepared key, nor accept an unusable vault.
  const unlocked={...info,privateKeys:await unlockVault(authentication.prfOutput,info.recipientId,info.vault)};check();
  let bootstrap=authentication.handoff?.diaryTrust||authentication.verified?.diaryTrust;
  if(authentication.handoff?.diaryTrust&&authentication.verified?.diaryTrust)await sameTrust(authentication.verified.diaryTrust,authentication.handoff.diaryTrust);
  const resumed=await resumeConfiguration(api,session,authentication,info.recipientId,check);
  if(resumed){if(bootstrap)await sameTrust(bootstrap,resumed);bootstrap=resumed;}
  let trust;
  if(info.vault.trust||bootstrap||pinnedTrust())trust=await resolveTrust({prf:authentication.prfOutput,recipientId:info.recipientId,sealed:info.vault.trust,bootstrap,pinned:pinnedTrust()});
  if(trust)await checkTrustFloor(trust,typeof localStorage==='undefined'?undefined:localStorage);
  check();trust=await approvePreparedRecipients(api,session,authentication,info.recipientId,trust,check);check();
  if(trust) {
    if(!info.vault.trust||info.vault.trust.generation!==trust.minimumGeneration) {
      startupProfile=null;
      const packet=await sealTrust(authentication.prfOutput,info.recipientId,trust);check();
      info=assertOwn(await api('/encryption/prepare',{method:'POST',body:{recipientId:info.recipientId,trust:packet}}));
    }
    if(!info.vault.trust)throw new Error('DiaryTrustNotSaved');
    await sameTrust(trust,await openTrust(authentication.prfOutput,info.recipientId,info.vault.trust));check();await remember(trust);authentication.diaryTrust=trust;
  }else if(session.encryption.enabled)throw new Error('日記の鍵の準備を待っています。管理者の次の利用後にログインし直してください。');
  if(session.isGlobalOwner&&trust&&session.keySession?.id&&session.encryption.phase!=='encrypted') {
    const {migrateDiaryOnLogin}=await import('./diary-automatic-migration.js');
    await migrateDiaryOnLogin({api,session,authentication,trust,check,onProgress});
    const fresh=await api('/session');check();
    if(!fresh.authenticated||JSON.stringify(session.keySession)!==JSON.stringify(fresh.keySession))throw Object.assign(new Error('ログイン状態が変わりました。'),{sessionChanged:true});
    Object.assign(session,fresh);
  }
  if(!authentication.diaryPrivateKeys)rememberPreparedVault(authentication,unlocked,unlocked.privateKeys);
  return startupProfile?{prepared:true,startupProfile}:{prepared:true};
}
