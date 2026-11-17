import {DIARY_READER_PROTOCOL,validatePublicTrust,open,b64,encode} from './crypto/e2ee/crypto.mjs';
import {unlockSession,takePreparedVault} from './crypto/e2ee/session.mjs';
import {bindingOf,verifyRecord} from './crypto/e2ee/record.mjs';
import {openCipherCache} from './crypto/e2ee/cache.mjs';
import {investmentRecords} from './crypto/e2ee/investment.mjs';
import {prepareDiaryKeys} from './diary-key-preparation.js';
import {saveDevice,loadDevice} from './crypto/e2ee/device.mjs';
import {sameTrust,checkTrustFloor,rememberTrustFloor} from './crypto/e2ee/trust.mjs';
const PIN='tlain-diary-authority-public-v1';
export async function importInvestmentTrust(file) {
  if(!file||file.size>12000)throw new Error('信頼設定ファイルを確認してください。');
  const trust=await validatePublicTrust(JSON.parse(await file.text()));localStorage.setItem(PIN,JSON.stringify(trust));return trust;
}
// Called only from the user's passkey button. No PRF, keys or decrypted
// portfolio values are persisted or sent to the server.
export async function loadEncryptedInvestment(session,authentication) {
  let state,cache;
  try {
    const request=async(path,body,headers={})=>{
      const response=await fetch('/diary/api'+path,{credentials:'same-origin',cache:'no-store',headers:{...headers,Accept:'application/json',...(body?{'Content-Type':'application/json','X-Diary-Request':'1'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
      const result=await response.json();if(!response.ok)throw Object.assign(new Error('資産データを安全に読み込めません。パスキーでログインし直してください。'),{status:response.status});return result;
    };
    if(authentication&&(authentication.link?.accountId!==session.encryption.accountId||!authentication.handoff?.handoffToken))throw new Error('AccountMismatch');
    const resumed=authentication?await request('/passkey/handoff',{handoffToken:authentication.handoff.handoffToken}):session;
    if(resumed.encryption?.accountId!==session.encryption.accountId)throw new Error('AccountMismatch');
    if(authentication)await prepareDiaryKeys((path,options={})=>request(path,options.body,options.headers),resumed,authentication);
    let trust=authentication?.diaryTrust||JSON.parse(localStorage.getItem(PIN)||'null');
    const initial=await request('/encryption/profile'),profile=initial.profile;
    if(initial.protocol!==DIARY_READER_PROTOCOL)throw new Error('UnsupportedReaderProtocol');
    if(profile.actor.accountId!==session.encryption.accountId||(authentication&&profile.webAuthnCredentialId!==authentication.credentialId)||!profile.actor.canViewInvestment)throw new Error('AccountMismatch');
    const prepared=authentication?.diaryPrivateKeys||takePreparedVault(authentication,profile);
    let cached=prepared?{privateKeys:prepared}:undefined,liveSession=resumed;
    if(!authentication){try{cached=await loadDevice(session,profile);}catch{/* Request the normal passkey if device storage is unavailable. */}if(!cached)throw new Error('PasskeyRequired');if(trust)await sameTrust(cached.trust,trust);else trust=cached.trust;}
    await validatePublicTrust(trust);
    await checkTrustFloor(trust,localStorage);
    state=await unlockSession({prf:authentication?.prfOutput,cachedPrivateKeys:cached?.privateKeys,profile,anchor:trust.anchor,minimumGeneration:Math.max(trust.minimumGeneration,initial.minimumGeneration),checkSession:async()=>{
      const current=await request('/session');const valid=current.authenticated&&current.encryption?.protocol===DIARY_READER_PROTOCOL&&current.encryption.accountId===profile.actor.accountId&&current.encryption.webAuthnCredentialId===profile.webAuthnCredentialId&&current.encryption.generation===initial.rollout.generation&&JSON.stringify(resumed.keySession)===JSON.stringify(current.keySession);if(valid)liveSession=current;return valid;
    }});
    try{await saveDevice(liveSession,profile,state.privateKeys,{...trust,minimumGeneration:state.directory.generation});}catch{/* The online passkey path remains available. */}
    const {record}=await request('/encryption/investment'),cacheKey=`investment/${profile.actor.accountId}/${profile.actor.credentialId}`;
    let previous,minimum=0;try{cache=await openCipherCache();previous=await cache.get(cacheKey);minimum=await cache.checkpoint(cacheKey)||previous?.sequence||0;}catch{/* Storage is optional; raw financial values are never cached. */}
    if(!record){if(minimum)throw new Error('RollbackDetected');return {records:[]};}
    await verifyRecord(record,state.directory);
    if(record.state!=='investment'||record.revision<minimum)throw new Error('RollbackDetected');
    if(previous?.sequence===record.revision&&b64(encode(previous.records))!==b64(encode([record])))throw new Error('RecordEquivocation');
    const value=await open(state.keys.get(record.scope),record.envelope,{...bindingOf(record),kind:'document'});
    if(value.version!==1)throw new Error('UnsupportedPayload');const records=investmentRecords(value.entry?.records);
    if(cache)try{await cache.put(cacheKey,{version:1,household:record.household,sequence:record.revision,baseSequence:-1,delta:false,unchanged:false,removed:[],records:[record]});}catch(error){if(error.message==='CacheRollbackRejected')throw new Error('RollbackDetected');}
    const current=await request('/session');
    if(!current.authenticated||current.encryption?.protocol!==DIARY_READER_PROTOCOL||current.encryption?.accountId!==profile.actor.accountId||current.encryption.webAuthnCredentialId!==profile.webAuthnCredentialId||current.encryption.generation!==initial.rollout.generation)throw new Error('SessionChanged');
    await rememberTrustFloor({...trust,minimumGeneration:state.directory.generation},localStorage);
    return {records,firstDate:records[0]?.date||null,lastDate:records.at(-1)?.date||null};
  }finally{authentication?.prfOutput?.fill(0);if(authentication){authentication.diaryPrivateKeys=null;authentication.diaryPreparedKeys=null;}state?.keys.clear();if(state)state.privateKeys=null;cache?.close();}
}
