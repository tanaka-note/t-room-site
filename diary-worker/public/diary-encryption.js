import { EncryptedDiaryClient } from './crypto/e2ee/client.mjs';
import { readSnapshotPages,LARGE_SNAPSHOT_PAGE_SIZE } from './crypto/e2ee/snapshot.mjs';
import { openCipherCache,openThumbnailCache } from './crypto/e2ee/cache.mjs';
import { createPrivateNavigation } from './crypto/e2ee/privacy.mjs';
import { createEncryptedDiaryApi } from './crypto/e2ee/ui-api.mjs';
import { createEncryptedMediaClient } from './crypto/e2ee/media-client.mjs';
import { validatePublicTrust,DIARY_READER_PROTOCOL } from './crypto/e2ee/crypto.mjs';
import {TRUST_PIN,sameTrust,checkTrustFloor,rememberTrustFloor} from './crypto/e2ee/trust.mjs';
import {saveDevice,loadDevice,clearDevice} from './crypto/e2ee/device.mjs';
import {takePreparedVault,photoReadContext} from './crypto/e2ee/session.mjs';
const PIN='tlain-diary-authority-public-v1';
export async function importDiaryTrust(file) {
  if(!file||file.size>12000)throw new Error('信頼設定ファイルを確認してください。');
  const value=await validatePublicTrust(JSON.parse(await file.text()));
  localStorage.setItem(PIN,JSON.stringify(value));return value;
}
export async function startEncryptedDiary(session,authentication,startupProfile) {try{return await createEncryptedDiary(session,authentication,startupProfile);}finally{authentication?.prfOutput?.fill(0);if(authentication){authentication.diaryPrivateKeys=null;authentication.diaryPreparedKeys=null;}}}
async function createEncryptedDiary(session,authentication,startupProfile) {
  let pin=authentication?.diaryTrust||JSON.parse(localStorage.getItem(TRUST_PIN)||'null');
  const nativeFetch=window.fetch.bind(window);
  const nativeApi=async(path,init={})=>{
    const headers=new Headers(init.headers);if(init.method&&init.method!=='GET')headers.set('X-Diary-Request','1');
    if(path.startsWith('/encryption/snapshot?'))headers.set('Accept','application/vnd.tlain.diary-snapshot+json');
    let body=init.body;if(body&&typeof body!=='string'&&!(body instanceof FormData)){headers.set('Content-Type','application/json');body=JSON.stringify(body);}
    const response=await nativeFetch(`/diary/api${path}`,{...init,headers,body,credentials:'same-origin',cache:'no-store'});
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'暗号化された日記を読み込めません。'),{status:response.status});return result;
  };
  const request=(path,init)=>nativeApi('/encryption'+path,init);
  const initial=startupProfile??await request('/profile');
  if(initial.protocol!==DIARY_READER_PROTOCOL)throw new Error('暗号化対応の最新版で開き直してください。');
  let cached={privateKeys:authentication?.diaryPrivateKeys||takePreparedVault(authentication,initial.profile)};
  if(!cached.privateKeys)cached=undefined;
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
  let firstView,releaseFirstView;
  const resetFirstView=()=>{releaseFirstView?.();firstView=new Promise(resolve=>{releaseFirstView=resolve;});};
  resetFirstView();
  const transport={
    backgroundReady:()=>firstView,
    valid:async signal=>{const generation=client.generation;try{const result=await nativeApi('/session',{signal});signal?.throwIfAborted();const valid=generation===client.generation&&!client.switching&&result.authenticated&&result.encryption?.enabled&&result.encryption.protocol===DIARY_READER_PROTOCOL&&result.encryption.accountId===expectedAccount&&result.encryption.webAuthnCredentialId===expectedCredential&&result.activeHouseholdId===client.household&&result.encryption.generation===initial.rollout.generation&&(!liveSession.keySession||JSON.stringify(liveSession.keySession)===JSON.stringify(result.keySession));if(valid){deadline=result.expiresAt||deadline;liveSession=result;await persistDevice();}return valid;}catch(error){if([401,403].includes(error.status))return false;throw error;}},
    timestamp:async()=>(await request('/time')).timestamp,
    snapshot:(household,since,{onPage,signal}={})=>readSnapshotPages(
      options=>request(`/snapshot?${new URLSearchParams(Object.entries(options).filter(([,value])=>value!==null))}`,{signal}),
      household,since,{onPage,pageLimit:LARGE_SNAPSHOT_PAGE_SIZE,
        fetchHead:h=>request(`/head?${new URLSearchParams({household:h,pageLimit:LARGE_SNAPSHOT_PAGE_SIZE})}`,{signal})}
    ),
    mutation:(proposal,operation)=>request('/mutation',{method:'POST',body:{proposal,operation}}),
    remove:proposal=>request('/remove',{method:'POST',body:proposal})
  };
  try{cache=await openCipherCache();}catch{/* A browser without IndexedDB can still decrypt online. */}
  client=new EncryptedDiaryClient({transport,profile:initial.profile,anchor:pin.anchor,minimumGeneration:Math.max(pin.minimumGeneration,initial.minimumGeneration),documentFormat:typeof CompressionStream==='function'?2:1,cache,lazy:true});
  client.onProgress=progress=>{
    const status=document.getElementById('diary-preparation-status');if(!status)return;
    status.hidden=['locked','complete'].includes(progress.phase);
    status.textContent=status.hidden?'':progress.phase==='index'?'日記の一覧を準備しています…':`残りのデータを準備しています（${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}件）… 日記は利用できます。`;
  };
  try{await client.unlock(authentication?.prfOutput,cached?.privateKeys);}
  catch(error){client.lock();cache?.close();throw error;}
  cached=null;
  navigation=await createPrivateNavigation(client);
  let photoBinding,thumbnailCache;
  media=createEncryptedMediaClient(client,request,nativeFetch,{
    getThumbnailCache:()=>thumbnailCache??=openThumbnailCache().catch(()=>null),
    encryptedOnly:initial.rollout.photoReadsEncryptedOnly===true,
    photoContext:()=>{
      if(photoBinding?.generation!==client.generation)photoBinding={generation:client.generation,
        context:photoReadContext(liveSession.keySession,client.household,initial.rollout.generation,client.directory.generation)};
      return photoBinding.context;
    },
    onPhotoExpiry:expiresAt=>{deadline=Math.max(deadline||0,expiresAt);}
  });
  api=createEncryptedDiaryApi(client,{session,nativeApi,media,parallelStartupRead:Boolean(startupProfile),prepareNavigation:signal=>navigation.prepareTags(signal),onHousehold:async household=>{
    const reply=await request('/profile');
    if(reply.profile.actor.accountId!==expectedAccount||reply.profile.webAuthnCredentialId!==expectedCredential||reply.profile.household!==household||reply.profile.directory.value.generation!==client.directory.generation){client.lock();throw new Error('パスキーでログインし直してください。');}
    media.reset();resetFirstView();
    navigation.close();if(/^\/diary\/tag\//.test(location.pathname))window.history.replaceState({},'','/diary/');client.records.clear();client.albumCache=null;client.revisionFloor.clear();client.sequence=undefined;client.profile={...client.profile,household};client.background=null;navigation=await createPrivateNavigation(client);
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
  const sessionIdentity=()=>JSON.stringify([liveSession.keySession||null,expectedAccount,expectedCredential,client.household,initial.rollout.generation]);
  let closed=false,external=false;
  const expire=()=>{if(closed)return;external=true;void lock();window.dispatchEvent(new Event('troom-session-expired'));};
  client.onBackgroundError=()=>expire();
  if(channel)channel.onmessage=event=>{
    if(event.data?.type!=='changed')return;
    // Opening another view of the same live session is not a logout. Older
    // readers and genuine session/household changes still invalidate this view.
    if(event.data.reason==='open'&&event.data.session===sessionIdentity())return;
    if(event.data.reason==='closed'&&event.data.session&&event.data.session!==sessionIdentity())return;
    expire();
  };
  const timer=setInterval(()=>{if(deadline&&Date.now()/1000>=deadline)return expire();if(!client.switching&&client.sequence!==undefined&&document.visibilityState==='visible'&&performance.now()-lastActivity<60000){const before=client.sequence,generation=client.generation;void client.sync().then(()=>{if(generation!==client.generation)return;client.startBackground();if(!client.closed&&client.sequence!==before)window.dispatchEvent(new Event('troom-diary-data-changed'));}).catch(error=>{if(generation===client.generation&&!client.switching&&([401,403].includes(error.status)||/Session|Signature|Rollback|GrantDenied|UnknownWriter/.test(error.message)))expire();});}},30000);
  window.addEventListener('troom-session-renewed',event=>{deadline=event.detail.expiresAt;},{signal:signals.signal});
  channel?.postMessage({type:'changed',reason:'open',session:sessionIdentity()});
  let cleanup;
  const lock=({logout=false}={})=>{
    if(cleanup)return cleanup;
    closed=true;releaseFirstView();clearInterval(timer);signals.abort();if(!external)channel?.postMessage({type:'changed',reason:logout?'logout':'closed',session:sessionIdentity()});channel?.close();
    client.lock();media.close();navigation.close();cache?.close();
    void thumbnailCache?.then(store=>store?.close());
    cleanup=clearDevice(liveSession,{all:logout}).catch(()=>{});return cleanup;
  };
  return {
    api:async(path,init)=>{
      try{return Response.json(await api(path,init));}
      catch(error){
        init?.signal?.throwIfAborted();
        if(error.name==='AbortError'||error.name==='TimeoutError')throw error;
        if(path!=='/logout'&&(error.status===401||client.closed))expire();
        // The authorized shell is already visible. Preserve HTTP failures so
        // the UI can close it immediately if the initial sync loses its session.
        const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;
        return Response.json({error:status===500?'日記を準備できませんでした。もう一度お試しください。':error.message},{status});
      }finally{if(path==='/logout')await lock({logout:true});}
    },fetch:async(...args)=>{try{const response=await media.fetch(...args);if(response.status===401||client.closed)expire();return response;}catch(error){if(error.status===401||client.closed)expire();throw error;}},readPhoto:async(...args)=>{try{return await media.read(...args);}catch(error){if(error.status===401||client.closed)expire();throw error;}},
    prefetchPhoto:async(...args)=>{try{await media.prefetch(...args);}catch(error){if(error.status===401||client.closed)expire();throw error;}},
    isPhotoCached:(...args)=>media.isPhotoCached(...args),
    presented:()=>releaseFirstView(),
    get storage(){return navigation.storage;},get history(){return navigation.history;},tagRoute:tag=>navigation.tagRoute(tag),tagValue:segment=>navigation.tagValue(segment),flush:()=>navigation.flush(),
    lock
  };
}
