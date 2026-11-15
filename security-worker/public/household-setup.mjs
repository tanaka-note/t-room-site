import {createClientVault,wrapMaster,unwrapMaster,keyScope} from '/household/household-crypto.mjs';
async function api(path,value) {
  const response=await fetch(`/security/api/household${path}`,{credentials:'same-origin',...(value?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result)throw new Error(result?.error||'鍵の状態を確認できませんでした。もう一度お試しください。');
  return result;
}
async function prepare(prf) {
  if(!prf)throw new Error('この環境ではパスキーによる暗号鍵の解除を利用できません。対応するブラウザでお試しください。');
  const own=await api('/own');
  if(!own.prepared)await api('/vault',await createClientVault(prf));
}
export async function prepareHousehold() {
  const auth=await TRoomPasskeys.authenticate('household',undefined,{handoff:false});
  try{await prepare(auth.prfOutput);return await api('/own');}finally{auth.prfOutput?.fill(0);}
}
export async function loadHouseholdApprovals(identityId,serviceLinkId) {
  const auth=await TRoomPasskeys.authenticate('security');let master;
  try{
    if(!auth.prfOutput)throw new Error('この環境では安全な鍵の解除を利用できません。');
    let status=await api(`/admin?serviceLinkId=${encodeURIComponent(serviceLinkId)}`);
    if(!status.adminEnvelope||!status.recoveryPublicKey)throw new Error('この管理者パスキーのT-Cloud鍵準備・復旧を先に完了してください。');
    const privateKey=await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput,status.adminEnvelope);
    if(!status.config){
      master=crypto.getRandomValues(new Uint8Array(32));
      const config={householdId:status.householdId,keyId:crypto.randomUUID()};
      await api('/initialize',{serviceLinkId,keyId:config.keyId,recoveryWrappedKey:await wrapMaster(master,status.recoveryPublicKey,keyScope(config))});
      status=await api(`/admin?serviceLinkId=${encodeURIComponent(serviceLinkId)}`);
    }else master=await unwrapMaster(privateKey,status.config.recoveryWrappedKey,keyScope(status.config));
    const approvals=[];
    for(const member of status.members.filter(m=>m.identityId===identityId && m.serviceLinkId===serviceLinkId)){
      const item={credentialId:member.credentialId,granted:Boolean(member.granted)};
      if(!member.granted){
        const wrappedKey=await wrapMaster(master,member.publicKey,keyScope(status.config)),keyId=status.config.keyId;
        item.approve=async()=>{
          const fresh=await TRoomPasskeys.authenticate('security');
          try{await api('/grant',{credentialId:member.credentialId,serviceLinkId:member.serviceLinkId,keyId,wrappedKey});}finally{fresh.prfOutput?.fill(0);}
        };
      }
      approvals.push(item);
    }
    return approvals;
  }finally{master?.fill(0);auth.prfOutput?.fill(0);}
}
