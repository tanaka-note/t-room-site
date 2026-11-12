import { createVault,validatePublicTrust } from '/security/diary-crypto/e2ee/crypto.mjs';
import { prepareKeyConfiguration,publicTrustPackage } from '/security/diary-crypto/e2ee/setup.mjs';
const PIN='tlain-diary-authority-public-v1';
async function api(path,value) {
  const response=await fetch(`/security/api/diary${path}`,{credentials:'same-origin',cache:'no-store',...(value?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})});
  const result=await response.json();if(!response.ok)throw new Error('日記の鍵を準備できません。本人確認と管理者の承認状態を確認してください。');return result;
}
async function prepare(prf) {
  if(!prf)throw new Error('この端末では暗号鍵を解除できません。PRF対応のパスキーとブラウザを使用してください。');
  const status=await api('/own');
  for(const link of status.links.filter(l=>!l.prepared))await api('/vault',{serviceLinkId:link.id,vault:await createVault(prf,link.recipientId)});
  return status;
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
  const auth=await TRoomPasskeys.authenticate('security');
  try {
    await prepare(auth.prfOutput);
    const status=await api('/admin');
    const existingIds=new Set(status.config?.directory.value.members.map(m=>m.credentialId)||[]);status.members=status.members.filter(m=>m.identityId==='primary-admin'||m.identityId===identityId||existingIds.has(m.credentialId));
    if(!status.adminEnvelope||!status.recoveryPublicKey)throw new Error('既存の管理者パスキーのT-Cloud利用準備・復旧登録を先に完了してください。');
    const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,status.adminEnvelope);
    const pin=JSON.parse(localStorage.getItem(PIN)||'null'),pending=JSON.parse(localStorage.getItem(PIN+'-pending')||'null');
    if(pin)await validatePublicTrust(pin);
    if(pending){if(status.config&&JSON.stringify(status.config.directory)===JSON.stringify(pending.directory)){localStorage.removeItem(PIN+'-pending');return publicTrustPackage(pending);}if((status.config?.generation||0)!==pending.expectedGeneration)throw new Error('鍵の更新結果を照合できません。元の信頼設定を保持して管理者に確認してください。');await api('/config',pending);localStorage.removeItem(PIN+'-pending');return publicTrustPackage(pending);}
    const recoveryRecords=[];let after=null;
    if(status.config)do {const page=await api(`/recovery-records${after?`?after=${encodeURIComponent(after)}`:''}`);recoveryRecords.push(...page.records);after=page.nextCursor;if(recoveryRecords.length>5000)throw new Error('復旧対象が上限を超えています。');}while(after);
    const configuration=await prepareKeyConfiguration({status,recoveryPrivateKey:privateKey,trustedAnchor:pin?.anchor,recoveryRecords});
    // Keep a freshly generated anchor locally before the first network write;
    // a lost response must not lose the original trust anchor.
    const trust=await publicTrustPackage(configuration);localStorage.setItem(PIN,JSON.stringify(trust));
    localStorage.setItem(PIN+'-pending',JSON.stringify(configuration));
    await api('/config',configuration);localStorage.removeItem(PIN+'-pending');
    return trust;
  }finally{auth.prfOutput?.fill(0);}
}
export function downloadDiaryTrust(value) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='diary-public-trust.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
