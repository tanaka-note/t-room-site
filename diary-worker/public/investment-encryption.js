import {DIARY_READER_PROTOCOL,validatePublicTrust,open,b64,encode} from './crypto/e2ee/crypto.mjs';
import {unlockSession} from './crypto/e2ee/session.mjs';
import {bindingOf,verifyRecord} from './crypto/e2ee/record.mjs';
import {openCipherCache} from './crypto/e2ee/cache.mjs';
import {investmentRecords} from './crypto/e2ee/investment.mjs';
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
    const trust=await validatePublicTrust(JSON.parse(localStorage.getItem(PIN)||'null'));
    const request=async(path,body)=>{
      const response=await fetch('/diary/api'+path,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json','X-Diary-Request':'1'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
      const result=await response.json();if(!response.ok)throw Object.assign(new Error('資産データを安全に読み込めません。パスキーでログインし直してください。'),{status:response.status});return result;
    };
    if(authentication.link?.accountId!==session.encryption.accountId||!authentication.handoff?.handoffToken)throw new Error('AccountMismatch');
    const resumed=await request('/passkey/handoff',{handoffToken:authentication.handoff.handoffToken});
    if(resumed.encryption?.accountId!==session.encryption.accountId)throw new Error('AccountMismatch');
    const initial=await request('/encryption/profile'),profile=initial.profile;
    if(initial.protocol!==DIARY_READER_PROTOCOL)throw new Error('UnsupportedReaderProtocol');
    if(profile.actor.accountId!==session.encryption.accountId||profile.webAuthnCredentialId!==authentication.credentialId||!profile.actor.canViewInvestment)throw new Error('AccountMismatch');
    state=await unlockSession({prf:authentication.prfOutput,profile,anchor:trust.anchor,minimumGeneration:Math.max(trust.minimumGeneration,initial.minimumGeneration),checkSession:async()=>{
      const current=await request('/session');return current.authenticated&&current.encryption?.protocol===DIARY_READER_PROTOCOL&&current.encryption.accountId===profile.actor.accountId&&current.encryption.webAuthnCredentialId===profile.webAuthnCredentialId&&current.encryption.generation===initial.rollout.generation;
    }});
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
    localStorage.setItem(PIN,JSON.stringify({...trust,minimumGeneration:state.directory.generation}));
    return {records,firstDate:records[0]?.date||null,lastDate:records.at(-1)?.date||null};
  }finally{authentication?.prfOutput?.fill(0);state?.keys.clear();if(state)state.privateKeys=null;cache?.close();}
}
