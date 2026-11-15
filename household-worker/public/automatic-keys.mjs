import {createClientVault,unlockClient,wrapMaster,unwrapMaster,keyScope} from './household-crypto.mjs';
const pending=()=>Object.assign(new Error('所有者が家計簿を開くと、暗号鍵の準備が自動で進みます。その後もう一度ログインしてください。'),{code:'key_pending'});
export async function unlockAutomaticPrivate(prf,vault){
  if(!vault.keySource)return unlockClient(prf,vault);
  const envelope={encryptedPayload:vault.ciphertext,payloadIv:vault.iv};
  if(vault.keySource==='tcloud-admin')return TRoomCrypto.unlockAdminPrivateKeyWithPasskey(prf,envelope);
  if(vault.keySource==='tcloud-member')return TRoomCrypto.unlockPasskeyClientPrivateKey(prf,envelope);
  throw new Error('暗号鍵の形式に対応していません。最新版でログインしてください。');
}
async function fingerprint(key){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(key)))),n=>n.toString(16).padStart(2,'0')).join('');}
async function grants(master,info,check){
  const result=[];
  for(const member of info.recipients.filter(m=>!m.granted)){
    result.push({credentialId:member.credentialId,serviceLinkId:member.serviceLinkId,wrappedKey:await wrapMaster(master,member.publicKey,keyScope(info.config))});check();
  }
  return result;
}
export async function prepareAutomaticKeys(api,session,prf,check=()=>{}){
  if(!(prf instanceof Uint8Array)||prf.length!==32)throw new Error('この環境ではパスキーによる暗号鍵の解除を利用できません。対応するブラウザでお試しください。');
  let info=await api('/keys/automatic');check();
  if(!info.vault){
    const vault=await createClientVault(prf);check();
    try{info=await api('/keys/automatic/vault',{vault});}
    catch(error){if(error.status!==409)throw error;info=await api('/keys/automatic');}check();
  }
  const privateKey=await unlockAutomaticPrivate(prf,info.vault);check();
  for(let attempt=0;attempt<2;attempt++){
    let master;
    try{
      if(!info.config){
        if(session.role!=='owner')throw pending();
        if(!info.recoveryPublicKey)throw new Error('T-Cloud管理者の復旧用公開鍵を確認できません。時間を置いて再試行してください。');
        master=crypto.getRandomValues(new Uint8Array(32));
        const config={householdId:info.householdId,keyId:crypto.randomUUID()};
        const payload={keyId:config.keyId,recoveryWrappedKey:await wrapMaster(master,info.recoveryPublicKey,keyScope(config)),recoveryKeyFingerprint:await fingerprint(info.recoveryPublicKey),grants:await grants(master,{...info,config},check)};check();
        info=await api('/keys/automatic/initialize',payload);check();
      }else{
        if(info.keyBundle)master=await unwrapMaster(privateKey,info.keyBundle.wrappedKey,keyScope(info.config));
        else if(session.role==='owner'&&info.vault.keySource==='tcloud-admin')master=await unwrapMaster(privateKey,info.config.recoveryWrappedKey,keyScope(info.config));
        else throw pending();check();
        if(session.role==='owner'){
          const wrapped=await grants(master,info,check);
          if(wrapped.length)info=await api('/keys/automatic/grants',{keyId:info.config.keyId,grants:wrapped});check();
        }
      }
      if(!info.keyBundle)throw pending();
      return {keyBundle:info.keyBundle,privateKey};
    }catch(error){
      if(error.status!==409||attempt===1)throw error;
      info=await api('/keys/automatic');check();
    }finally{master?.fill(0);}
  }
}
export async function shareAutomaticKeys(api,session,privateKey,check=()=>{}){
  if(session.role!=='owner'||!privateKey)return;
  const info=await api('/keys/automatic');check();
  if(!info.keyBundle||info.config?.keyId!==session.keyBundle?.keyId)throw new Error('暗号鍵の状態が変わりました。パスキーでログインし直してください。');
  if(!info.recipients.some(m=>!m.granted))return;
  const master=await unwrapMaster(privateKey,info.keyBundle.wrappedKey,keyScope(info.config));
  try{const wrapped=await grants(master,info,check);await api('/keys/automatic/grants',{keyId:info.config.keyId,grants:wrapped});check();}
  finally{master.fill(0);}
}
