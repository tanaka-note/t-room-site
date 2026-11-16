import { EncryptedDiaryClient } from './crypto/e2ee/client.mjs';
import { readSnapshotPages } from './crypto/e2ee/snapshot.mjs';
import { openCipherCache } from './crypto/e2ee/cache.mjs';
import { createPrivateNavigation } from './crypto/e2ee/privacy.mjs';
import { createEncryptedDiaryApi } from './crypto/e2ee/ui-api.mjs';
import { createEncryptedMediaClient } from './crypto/e2ee/media-client.mjs';
import { validatePublicTrust,DIARY_READER_PROTOCOL } from './crypto/e2ee/crypto.mjs';
import {TRUST_PIN,sameTrust,checkTrustFloor,rememberTrustFloor} from './crypto/e2ee/trust.mjs';
import {saveDevice,loadDevice,clearDevice} from './crypto/e2ee/device.mjs';
const PIN='tlain-diary-authority-public-v1';
export async function importDiaryTrust(file) {
  if(!file||file.size>12000)throw new Error('信頼設定ファイルを確認してください。');
  const value=await validatePublicTrust(JSON.parse(await file.text()));
  localStorage.setItem(PIN,JSON.stringify(value));return value;
}
export async function startEncryptedDiary(session,authentication) {try{return await createEncryptedDiary(session,authentication);}finally{authentication?.prfOutput?.fill(0);}}
async function createEncryptedDiary(session,authentication) {
  let pin=authentication?.diaryTrust||JSON.parse(localStorage.getItem(TRUST_PIN)||'null');
  const nativeFetch=window.fetch.bind(window);
  const nativeApi=async(path,init={})=>{
    const headers=new Headers(init.headers);if(init.method&&init.method!=='GET')headers.set('X-Diary-Request','1');
    let body=init.body;if(body&&typeof body!=='string'&&!(body instanceof FormData)){headers.set('Content-Type','application/json');body=JSON.stringify(body);}
    const response=await nativeFetch(`/diary/api${path}`,{...init,headers,body,credentials:'same-origin',cache:'no-store'});
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'暗号化された日記を読み込めません。'),{status:response.status});return result;
  };
  const request=(path,init)=>nativeApi('/encryption'+path,init);
  const initial=await request('/profile');
  if(initial.protocol!==DIARY_READER_PROTOCOL)throw new Error('暗号化対応の最新版で開き直してください。');
  let cached;
  if(!authentication?.prfOutput) {
    try{cached=await loadDevice(session,initial.profile);}catch{/* Authenticate again if secure device storage is unavailable. */}
    if(!cached)throw new Error('パスキーでログインしてください。');
    if(pin)await sameTrust(cached.trust,pin);else pin=cached.trust;
  }
  if(!pin)throw new Error('日記の鍵設定を確認するため、パスキーでログインし直してください。');
  await validatePublicTrust(pin);
  await checkTrustFloor(pin,localStorage);
  if(authentication&&initial.profile.webAuthnCredentialId!==authentication.credentialId)throw new Error('ログインしたパスキーが一致しません。');
  const expectedAccount=initial.profile.actor.accountId,expectedCredential=initial.profile.webAuthnCredentialId;
  let client,navigation,api,media,cache,deadline=session.expiresAt||null;
  let liveSession=session,persistDevice=async()=>{};
  const transport={
    valid:async()=>{try{const result=await nativeApi('/session');deadline=result.expiresAt||deadline;const valid=result.authenticated&&result.encryption?.enabled&&result.encryption.protocol===DIARY_READER_PROTOCOL&&result.encryption.accountId===expectedAccount&&result.encryption.webAuthnCredentialId===expectedCredential&&result.activeHouseholdId===client.household&&result.encryption.generation===initial.rollout.generation&&(!liveSession.keySession||JSON.stringify(liveSession.keySession)===JSON.stringify(result.keySession));if(valid){liveSession=result;await persistDevice();}return valid;}catch(error){if([401,403].includes(error.status))return false;throw error;}},
    timestamp:async()=>(await request('/time')).timestamp,
    snapshot:(household,since)=>readSnapshotPages(options=>request(`/snapshot?${new URLSearchParams(Object.entries(options).filter(([,value])=>value!==null))}`),household,since,{fetchHead:h=>request(`/head?household=${encodeURIComponent(h)}`)}),
    mutation:(proposal,operation)=>request('/mutation',{method:'POST',body:{proposal,operation}}),
    remove:proposal=>request('/remove',{method:'POST',body:proposal})
  };
  try{cache=await openCipherCache();}catch{/* A browser without IndexedDB can still decrypt online. */}
  client=new EncryptedDiaryClient({transport,profile:initial.profile,anchor:pin.anchor,minimumGeneration:Math.max(pin.minimumGeneration,initial.minimumGeneration),documentFormat:typeof CompressionStream==='function'?2:1,cache});
  try{await client.unlock(authentication?.prfOutput,cached?.privateKeys);await client.sync();}
  catch(error){client.lock();cache?.close();throw error;}
  navigation=await createPrivateNavigation(client);
  media=createEncryptedMediaClient(client,request,nativeFetch);
  api=createEncryptedDiaryApi(client,{session,nativeApi,media,prepareNavigation:()=>navigation.prepareTags(),onHousehold:async household=>{
    const reply=await request('/profile');
    if(reply.profile.actor.accountId!==expectedAccount||reply.profile.webAuthnCredentialId!==expectedCredential||reply.profile.household!==household||reply.profile.directory.value.generation!==client.directory.generation){client.lock();throw new Error('パスキーでログインし直してください。');}
    navigation.close();if(/^\/diary\/tag\//.test(location.pathname))window.history.replaceState({},'','/diary/');client.generation++;client.records.clear();client.revisionFloor.clear();client.sequence=undefined;client.profile={...client.profile,household};await client.sync();navigation=await createPrivateNavigation(client);
  }});
  await rememberTrustFloor({...pin,minimumGeneration:client.directory.generation},localStorage);
  let lastDeviceSave=0;
  persistDevice=async()=>{
    if(client.closed||Date.now()-lastDeviceSave<60000)return;lastDeviceSave=Date.now();
    try{await saveDevice(liveSession,initial.profile,client.privateKeys,{...pin,minimumGeneration:client.directory.generation});}catch{/* Passkey login remains available without device storage. */}
  };
  await persistDevice();
  const signals=new AbortController();let lastActivity=performance.now();
  for(const type of ['pointerdown','keydown','touchstart','wheel'])document.addEventListener(type,event=>{if(event.isTrusted)lastActivity=performance.now();},{passive:true,signal:signals.signal});
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('tlain-diary-session-change'):null;
  let closed=false,external=false;
  const expire=()=>{if(closed)return;external=true;client.lock();void clearDevice(liveSession).catch(()=>{});window.dispatchEvent(new Event('troom-session-expired'));};
  if(channel)channel.onmessage=expire;
  const timer=setInterval(()=>{if(deadline&&Date.now()/1000>=deadline)return expire();if(document.visibilityState==='visible'&&performance.now()-lastActivity<60000)void client.sync().catch(error=>{if([401,403].includes(error.status)||/Session|Signature|Rollback|GrantDenied|UnknownWriter/.test(error.message))expire();});},30000);
  window.addEventListener('troom-session-renewed',event=>{deadline=event.detail.expiresAt;},{signal:signals.signal});
  channel?.postMessage({type:'changed'});
  return {
    api:async(path,init)=>{const value=await api(path,init);return Response.json(value);},fetch:media.fetch,
    get storage(){return navigation.storage;},get history(){return navigation.history;},tagRoute:tag=>navigation.tagRoute(tag),tagValue:segment=>navigation.tagValue(segment),flush:()=>navigation.flush(),
    lock(){if(closed)return;closed=true;clearInterval(timer);signals.abort();if(!external)channel?.postMessage({type:'changed'});channel?.close();client.lock();void clearDevice(liveSession).catch(()=>{});media.close();navigation.close();cache?.close();}
  };
}
