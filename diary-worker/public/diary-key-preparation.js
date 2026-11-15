import {createVault,unlockVault} from './crypto/e2ee/crypto.mjs';

// Called by the normal Diary passkey login. The caller owns and clears PRF;
// only the sealed vault and public keys cross the service API.
export async function prepareDiaryKeys(api,session,authentication,check=()=>{}) {
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
  return {prepared:true};
}
