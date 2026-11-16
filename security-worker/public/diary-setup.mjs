import { createVault,validatePublicTrust,unlockVault,unb64 } from '/security/diary-crypto/e2ee/crypto.mjs';
import { prepareKeyConfiguration,publicTrustPackage } from '/security/diary-crypto/e2ee/setup.mjs';
import {resolveTrust,sealTrust,openTrust,sameTrust} from '/security/diary-crypto/e2ee/trust.mjs';
const PIN='tlain-diary-authority-public-v1';
async function api(path,value) {
  const response=await fetch(`/security/api/diary${path}`,{credentials:'same-origin',cache:'no-store',...(value?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error('日記の鍵を準備できません。本人確認と管理者の承認状態を確認してください。'),{status:response.status});return result;
}
async function prepare(prf) {
  if(!prf)throw new Error('この端末では暗号鍵を解除できません。PRF対応のパスキーとブラウザを使用してください。');
  const status=await api('/own');
  for(const link of status.links.filter(l=>!l.prepared))await api('/vault',{serviceLinkId:link.id,vault:await createVault(prf,link.recipientId)});
  return api('/own');
}
async function authenticationTrust(auth,own) {
  const pinned=JSON.parse(localStorage.getItem(PIN)||'null'),link=own.links.find(link=>link.trust)||own.links[0];
  const bootstrap=auth.verified?.diaryTrust;
  if(!pinned&&!link?.trust&&!bootstrap)return null;
  const trust=await resolveTrust({prf:auth.prfOutput,recipientId:link.recipientId,sealed:link.trust,bootstrap,pinned});
  localStorage.setItem(PIN,JSON.stringify(trust));return trust;
}
async function saveAuthenticationTrust(auth,own,trust) {
  for(const link of own.links) {
    const {trust:saved}=await api('/trust',{serviceLinkId:link.id,trust:await sealTrust(auth.prfOutput,link.recipientId,trust)});
    await sameTrust(trust,await openTrust(auth.prfOutput,link.recipientId,saved));
  }
  localStorage.setItem(PIN,JSON.stringify(trust));return trust;
}
export async function prepareDiary() {
  const auth=await TRoomPasskeys.authenticate('diary',undefined,{handoff:false});
  try{await prepare(auth.prfOutput);return {prepared:true};}finally{auth.prfOutput?.fill(0);}
}
export async function importDiaryTrust(file) {
  if(!file||file.size>12000)throw new Error('信頼設定ファイルを確認してください。');
  const value=await validatePublicTrust(JSON.parse(await file.text()));
  localStorage.setItem(PIN,JSON.stringify(value));return value;
}
export async function configureDiary({identityId}={}) {
  let auth,stage='AUTH';
  try {
    auth=await TRoomPasskeys.authenticate('security');
    stage='VAULT';const own=await prepare(auth.prfOutput);
    stage='STATUS';const status=await api('/admin');
    const existingIds=new Set(status.config?.directory.value.members.map(m=>m.credentialId)||[]);status.members=status.members.filter(m=>m.identityId==='primary-admin'||m.identityId===identityId||existingIds.has(m.credentialId));
    if(!status.adminEnvelope||!status.recoveryPublicKey)throw new Error('既存の管理者パスキーのT-Cloud利用準備・復旧登録を先に完了してください。');
    stage='RECOVERY';const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,status.adminEnvelope);
    stage='TRUST';const pin=await authenticationTrust(auth,own),pending=JSON.parse(localStorage.getItem(PIN+'-pending')||'null');
    if(pin)await validatePublicTrust(pin);
    if(pending){if(status.config&&JSON.stringify(status.config.directory)===JSON.stringify(pending.directory)){localStorage.removeItem(PIN+'-pending');return await saveAuthenticationTrust(auth,own,await publicTrustPackage(pending));}if((status.config?.generation||0)!==pending.expectedGeneration)throw new Error('鍵の更新結果を照合できません。元の信頼設定を保持して管理者に確認してください。');stage='SAVE';await api('/config',pending);localStorage.removeItem(PIN+'-pending');return await saveAuthenticationTrust(auth,own,await publicTrustPackage(pending));}
    stage='RECORDS';const recoveryRecords=[];let after=null;
    if(status.config)do {const page=await api(`/recovery-records${after?`?after=${encodeURIComponent(after)}`:''}`);recoveryRecords.push(...page.records);after=page.nextCursor;if(recoveryRecords.length>5000)throw new Error('復旧対象が上限を超えています。');}while(after);
    stage='KEYS';const configuration=await prepareKeyConfiguration({status,recoveryPrivateKey:privateKey,trustedAnchor:pin?.anchor,recoveryRecords});
    // Keep a freshly generated anchor locally before the first network write;
    // a lost response must not lose the original trust anchor.
    const trust=await publicTrustPackage(configuration);localStorage.setItem(PIN,JSON.stringify(trust));
    localStorage.setItem(PIN+'-pending',JSON.stringify(configuration));
    stage='SAVE';await api('/config',configuration);localStorage.removeItem(PIN+'-pending');
    return await saveAuthenticationTrust(auth,own,trust);
  }catch(error){
    if(error.message==='TrustedAnchorRequired')throw new Error('日記の信頼設定を確認できません。パスキーでログインし直してください。');
    if(error.message==='RekeyRequired')throw new Error('失効や権限変更があるため、通常の承認ではなく鍵更新が必要です。');
    if(!error.status&&/[\u3040-\u30ff\u3400-\u9fff]/.test(error.message||''))throw error;
    const labels={AUTH:'本人確認',VAULT:'本人の鍵の登録',STATUS:'管理者設定の確認',RECOVERY:'既存の管理者復旧鍵の解除',TRUST:'端末の信頼設定の確認',RECORDS:'既存の鍵情報の確認',KEYS:'日記の鍵設定の作成',SAVE:'鍵設定の保存'};
    throw new Error(`${labels[stage]}を完了できませんでした（DKEY-${stage}${Number.isInteger(error.status)?'-'+error.status:''}）。この表示を管理者にお伝えください。`);
  }finally{auth?.prfOutput?.fill(0);}
}
export function downloadDiaryTrust(value) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='diary-public-trust.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export async function prepareDiaryData({kind='migration',onProgress=()=>{}}={}) {
  if(!['migration','rotation'].includes(kind))throw new Error('移行する処理を確認してください。');
  const auth=await TRoomPasskeys.authenticate('security');let plans;
  try {
    const status=await api('/admin');
    if(!status.config)throw new Error('日記の管理者設定はまだ保存されていません。利用設定の状態を確認してください。');
    if(kind==='migration'&&status.writerReadiness?.ready===false)throw new Error('全利用者の鍵の準備・承認が完了していません。移行の開始状態は変更していません。');
    const trust=await authenticationTrust(auth,await prepare(auth.prfOutput));
    if(!auth.prfOutput||!status.adminEnvelope)throw new Error('日記のログインで使った、管理者復旧に対応するパスキーを選んでください。');
    const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,status.adminEnvelope);
    const maintenance=await import('/security/diary-crypto/e2ee/maintenance.mjs');plans=await maintenance.openMaintenancePlans();
    const prepared=await maintenance.prepareDiaryMaintenance({kind,api,recoveryPrivateKey:privateKey,trust,plans,onProgress});
    const checkpoint=await api('/maintenance/backup',{});
    return {...prepared,checkpoint};
  }finally{plans?.close();auth.prfOutput?.fill(0);}
}

// One admin operation prepares, restores an actual backup into isolated
// SQLite on this device, compares/decrypts it, and signs the existing cutover.
// Only ciphertext/public metadata cross the API; no downloadable report.
export async function migrateDiary({kind='migration',onProgress=()=>{}}={}) {
  const auth=await TRoomPasskeys.authenticate('security');let plans;
  try {
    const own=await prepare(auth.prfOutput),trust=await authenticationTrust(auth,own),status=await api('/admin');
    if(!status.config||!trust)throw new Error('日記の鍵設定を先に完了してください。');
    if(kind==='migration'&&status.writerReadiness?.ready===false)throw new Error('日記の利用者全員が通常のパスキーログインを行った後、管理者として日記を開いてください。投稿停止は開始していません。');
    const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,status.adminEnvelope);
    const maintenance=await import('/security/diary-crypto/e2ee/maintenance.mjs');plans=await maintenance.openMaintenancePlans();
    await maintenance.prepareDiaryMaintenance({kind,api,recoveryPrivateKey:privateKey,trust,plans,onProgress});
    // A recovered/new admin credential joins the directory during rotation.
    // Obtain its normal signing vault after that transaction, not beforehand.
    const signing=await api('/maintenance/signing-vault',{}),vault=await unlockVault(auth.prfOutput,signing.recipientId,signing.vault);
    auth.prfOutput.fill(0);
    const checkpoint=await api('/maintenance/backup',{});
    let manifest;
    for(let attempt=0;attempt<120;attempt++) {
      manifest=await api('/maintenance/checkpoint?'+new URLSearchParams({checkpoint:checkpoint.checkpoint}));
      if(manifest.ready)break;
      onProgress({phase:'backup',completed:attempt});
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    if(!manifest?.ready)throw new Error('バックアップの準備中です。同じ端末から移行を再開してください。');
    const {restoreDiaryCheckpoint}=await import('/security/diary-restore.mjs');
    let parts;
    const object=value=>({body:new Blob([unb64(value.bytes,24_000_000)]).stream(),customMetadata:{sha256:value.sha256}});
    const bucket={get:async key=>{
      if(key===checkpoint.key)return object(manifest);
      if(!parts){const data=await new Response(object(manifest).body.pipeThrough(new DecompressionStream('gzip'))).json();parts=data.parts;}
      const index=parts.findIndex(part=>part.key===key);if(index<0)throw new Error('InvalidCheckpointPart');
      return object(await api('/maintenance/checkpoint?'+new URLSearchParams({checkpoint:checkpoint.checkpoint,part:index})));
    }};
    const report=await restoreDiaryCheckpoint({bucket,key:checkpoint.key,trust,onProgress});
    const {build}=await api('/maintenance/build');
    return await maintenance.finishDiaryMaintenance({api,recoveryPrivateKey:privateKey,signingKey:vault.sign,trust,plans,report,readerBuild:build,writerBuild:build});
  }finally{plans?.close();auth.prfOutput?.fill(0);}
}

export async function finishDiaryData(file) {
  if(!file||file.size>100_000_000)throw new Error('復元確認ファイルを確認してください。');
  const report=JSON.parse(await file.text()),auth=await TRoomPasskeys.authenticate('security');let plans;
  try {
    const trust=await authenticationTrust(auth,await prepare(auth.prfOutput));await validatePublicTrust(trust);
    const status=await api('/admin');
    const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,status.adminEnvelope);
    const own=await api('/maintenance/signing-vault',{});
    const {unlockVault}=await import('/security/diary-crypto/e2ee/crypto.mjs');
    const vault=await unlockVault(auth.prfOutput,own.recipientId,own.vault);
    const maintenance=await import('/security/diary-crypto/e2ee/maintenance.mjs');plans=await maintenance.openMaintenancePlans();
    const {build}=await api('/maintenance/build');
    return await maintenance.finishDiaryMaintenance({api,recoveryPrivateKey:privateKey,signingKey:vault.sign,trust,plans,report,readerBuild:build,writerBuild:build});
  }finally{plans?.close();auth.prfOutput?.fill(0);}
}

export async function currentDiaryTrust() {
  return validatePublicTrust(JSON.parse(localStorage.getItem(PIN)||'null'));
}


export async function importDiaryInvestment(file) {
  if(!file||file.size>20_000_000)throw new Error('投資履歴ファイルを確認してください。');
  const input=JSON.parse(await file.text()),auth=await TRoomPasskeys.authenticate('security');let plans,key;
  try {
    const crypto=await import('/security/diary-crypto/e2ee/crypto.mjs');
    const record=await import('/security/diary-crypto/e2ee/record.mjs');
    const investment=await import('/security/diary-crypto/e2ee/investment.mjs');
    const maintenance=await import('/security/diary-crypto/e2ee/maintenance.mjs');
    const trust=await validatePublicTrust(JSON.parse(localStorage.getItem(PIN)||'null')),status=await api('/admin');
    if(status.rollout.phase!=='encrypted')throw new Error('日記の暗号化移行・鍵更新を完了してから投資履歴を更新してください。');
    const directory=await crypto.verifyDirectory(status.config.directory,trust.anchor,trust.minimumGeneration),own=await api('/maintenance/signing-vault',{});
    const vault=await crypto.unlockVault(auth.prfOutput,own.recipientId,own.vault),binding=investment.investmentBinding(directory);
    const grant=own.grants.find(packet=>packet.value.scope===binding.scope);if(!grant)throw new Error('InvestmentGrantRequired');
    key=await crypto.unwrapGrant(grant,{directory,anchor:trust.anchor,accountId:own.accountId,credentialId:own.recipientId,household:binding.household,scope:binding.scope,epoch:binding.epoch,privateKey:vault.rsa});
    const incoming=investment.investmentRecords(Array.isArray(input)?input:input.records);
    if(!incoming.length)throw new Error('更新する投資履歴がありません。');
    plans=await maintenance.openMaintenancePlans();let pending=await plans.getInvestment();
    if(pending) {
      const next={...binding,revision:pending.proposal.expectedRevision+1};
      const value=await crypto.open(key,pending.proposal.envelope,{...next,kind:'document'}),prepared=investment.investmentRecords(value.entry.records);
      if(incoming.some(row=>!prepared.some(previous=>previous.date===row.date&&crypto.b64(crypto.encode(previous))===crypto.b64(crypto.encode(row)))))throw new Error('前回と同じ投資履歴ファイルで再試行してください。');
    } else {
      const {record:current}=await api('/investment');let existing=[];
      if(current){await record.verifyRecord(current,directory);existing=(await crypto.open(key,current.envelope,{...record.bindingOf(current),kind:'document'})).entry.records;investment.investmentRecords(existing);}
      const rows=new Map(existing.map(row=>[row.recorded_at??row.date,row]));for(const row of incoming)rows.set(row.date,{recorded_at:row.date,...Object.fromEntries(investment.INVESTMENT_VALUES.map(name=>[name,row[name]])),updated_at:new Date().toISOString()});
      const sealed=await investment.sealInvestment({records:[...rows.values()],current,directory,key,signingKey:vault.sign,writer:own.recipientId});
      pending={proposal:investment.investmentProposal(sealed,cryptoRandomId())};await plans.putInvestment(pending);
    }
    await api('/investment',pending);await plans.clearInvestment();return {completed:true};
  }finally{plans?.close();key=null;auth.prfOutput?.fill(0);}
}
function cryptoRandomId(){return crypto.randomUUID();}
