import {b64, encode, newKey, open, openRecipientKey, recipientKeyBox, seal, signed, unb64, unlockVault, verifyDirectory} from './crypto/e2ee/crypto.mjs';
import {checkTrustFloor, resolveTrust, TRUST_PIN} from './crypto/e2ee/trust.mjs';
import {bindingOf, proofOf, verifyRecord} from './crypto/e2ee/record.mjs';
import {mediaBinding} from './crypto/e2ee/rotation.mjs';
import {openRecoveryEnvelope} from './crypto/e2ee/recovery.mjs';
import {unlockCentralRecovery} from './crypto/e2ee/tcloud-recovery.mjs';
import {decryptPhotoPart, encryptPhotoMigrationPart, PHOTO_PREFIX} from './crypto/e2ee/photo-crypto.mjs';

const kinds = ['original','display','thumbnail'];
const root = '/encryption/photo-migration';
const equal = (a,b) => b64(encode(a))===b64(encode(b));
const hash = async blob => b64(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
const partBinding = (row,run,kind) => ({...mediaBinding(row),sourceId:run,kind:`photo-migration-${kind}`});
const phase = (status,message) => Object.assign(new Error(message),{status});

export function migrationTransport(nativeFetch,token) {
  return async (path,{method='GET',body,signal,binary=false,optional=false,keepalive=false}={}) => {
    const headers = new Headers({'X-Diary-Photo-Session':token});
    if(method!=='GET')headers.set('X-Diary-Request','1');
    if(body!==undefined)headers.set('Content-Type',body instanceof Blob?'application/octet-stream':'application/json');
    const reply=await nativeFetch(`/diary/api${path}`,{method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',
      body:body===undefined||body instanceof Blob?body:JSON.stringify(body),signal,keepalive});
    if(optional&&reply.status===404)return null;
    if(!reply.ok) {
      const error=await reply.json().catch(()=>({}));
      throw phase(reply.status,error.error||'PhotoMigrationUnavailable');
    }
    return binary?reply:reply.json();
  };
}

function scopeKey(kit,row) {
  const key=kit.scopeKeys.get(row.scope);
  if(!key)throw new Error('PhotoMigrationKeyMissing');
  return key;
}

async function recordKey(kit,privateKey,row) {
  return Object.keys(row.keyBox).length?openRecipientKey(row.keyBox,{...bindingOf(row),kind:'record-key'},'__recovery__',privateKey):scopeKey(kit,row);
}

async function photoDescriptor(kit,row,metadata) {
  const binding=mediaBinding(row);
  const photo=await open(scopeKey(kit,binding),JSON.parse(metadata),binding);
  if(photo.id!==row.id)return Promise.reject(new Error('PhotoMigrationRecordMismatch'));
  return photo;
}

async function runPhotoParts(signal,operation) {
  signal.throwIfAborted();
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  try {
    // Let every part settle after cancellation before the caller releases the lease.
    await Promise.all(kinds.map(async kind=>{
      try {await operation(kind,controller.signal);}
      catch(error) {controller.abort(error);}
    }));
    controller.signal.throwIfAborted();
  } finally {signal.removeEventListener('abort',abort);}
}

export async function migratePhoto({row,item,run,kit,signingKey,send,signal}) {
  const photo=await photoDescriptor(kit,row,item?JSON.stringify(item.metadata):row.metadata);
  const binding=mediaBinding(row), wrappingKey=scopeKey(kit,binding), freshlyEncrypted=new Map();
  if(!item) {
    if(photo.crypto)throw new Error('PhotoMigrationRecordMismatch');
    const raw=crypto.getRandomValues(new Uint8Array(32));
    photo.crypto={version:1,key:b64(raw),types:{original:photo.contentType||'application/octet-stream',display:'image/webp',thumbnail:'image/webp'}};
    raw.fill(0);
    const parts={};
    await runPhotoParts(signal,async (kind,partSignal)=>{
      const source=await send(`/source/${row.id}/${kind}`,{binary:true,signal:partSignal}),blob=await source.blob();
      const etag=source.headers.get('ETag')?.replace(/^"|"$/g,''), sourceDigest=await hash(blob);
      const nonce=crypto.getRandomValues(new Uint8Array(12));
      const cipher=await encryptPhotoMigrationPart(blob,photo.crypto,row.household,row.id,kind,nonce,sourceDigest);
      parts[kind]={etag,bytes:cipher.size,sha256:await hash(cipher),check:await seal(wrappingKey,{sourceDigest,nonce:b64(nonce)},partBinding(row,run,kind))};
      freshlyEncrypted.set(kind,cipher);
    });
    const metadata=await seal(wrappingKey,photo,binding);
    // Reserve the exact bytes and the sealed input proof before performing PUT.
    await send('/reserve',{method:'POST',body:{id:row.id,parts,metadata}});
    item={metadata,parts};
  }
  if(photo.crypto?.version!==1)throw new Error('PhotoMigrationRecordMismatch');
  await runPhotoParts(signal,async (kind,partSignal)=>{
    const path=`/target/${row.id}/${kind}`,part=item.parts[kind];
    const check=await open(wrappingKey,part.check,partBinding(row,run,kind));
    let stored=freshlyEncrypted.has(kind)?null:await send(path,{binary:true,optional:true,signal:partSignal});
    if(!stored) {
      let cipher=freshlyEncrypted.get(kind);
      if(!cipher) {
        const source=await send(`/source/${row.id}/${kind}`,{binary:true,signal:partSignal});
        if(source.headers.get('ETag')?.replace(/^"|"$/g,'')!==part.etag)throw new Error('PhotoSourceChanged');
        cipher=await encryptPhotoMigrationPart(await source.blob(),photo.crypto,row.household,row.id,kind,unb64(check.nonce,16),check.sourceDigest);
        if(await hash(cipher)!==part.sha256)throw new Error('PhotoMigrationTargetConflict');
      }
      await send(path,{method:'PUT',body:cipher,signal:partSignal});
      freshlyEncrypted.delete(kind);
      stored=await send(path,{binary:true,signal:partSignal});
    }
    const ciphertext=await stored.blob();
    if(await hash(ciphertext)!==part.sha256)throw new Error('PhotoMigrationTargetConflict');
    const restored=await decryptPhotoPart(await ciphertext.arrayBuffer(),photo.crypto,row.household,row.id,kind);
    if(await hash(restored)!==check.sourceDigest)throw new Error('PhotoMigrationRestoreMismatch');
  });
  const proof=await signed({run,id:row.id,hashes:kinds.map(kind=>item.parts[kind].sha256)},signingKey);
  await send('/verify',{method:'POST',body:proof});
}

export async function preparePhotoMigrationRecord({row,advanceSource,media,kit,privateKey,directory,recipientId,signingKey}) {
  await verifyRecord(row,directory);
  const old=bindingOf(row), key=await recordKey(kit,privateKey,row);
  const document=await open(key,row.envelope,{...old,kind:'document'});
  const summary=await open(key,row.summary,{...old,kind:'summary'});
  const affected=new Map();
  for(const image of media) {
    const photo=await photoDescriptor(kit,image,image.candidate);
    if(image.household!==row.household||photo.crypto?.version!==1)throw new Error('PhotoMigrationRecordMismatch');
    affected.set(image.id,photo.crypto);
  }
  const seen=new Set();
  document.entry.photos=document.entry.photos.map(photo=>{
    if(!affected.has(photo.id))return photo;
    if(photo.crypto)throw new Error('PhotoMigrationRecordMismatch');
    seen.add(photo.id);
    return {...photo,crypto:affected.get(photo.id)};
  });
  if(seen.size!==affected.size)throw new Error('PhotoMigrationRecordMismatch');
  const next={...row,revision:row.revision+1,sourceRevision:advanceSource?row.sourceRevision+1:row.sourceRevision,
    attestation:{writer:recipientId}};
  const binding=bindingOf(next);
  const outputKey=Object.keys(row.keyBox).length?await newKey():key;
  if(Object.keys(row.keyBox).length)next.keyBox=await recipientKeyBox(outputKey,{...binding,kind:'record-key'},
    directory.members.filter(m=>m.scopes.includes(row.scope)),directory.recoveryPublicKey);
  next.envelope=await seal(outputKey,document,{...binding,kind:'document'},{format:row.envelope.version});
  next.summary=await seal(outputKey,summary,{...binding,kind:'summary'});
  next.attestation.signature=(await signed(proofOf(next),signingKey)).signature;
  await verifyRecord(next,directory,{currentRecipients:true});
  return next;
}

export async function checkPhotoMigrationRestore({report,run,sequence,directory,privateKey,kit,send,signal}) {
  if(report.directoryGeneration!==directory.generation||report.sequence!==sequence)throw new Error('PhotoMigrationRestoreMismatch');
  const prefix=`${PHOTO_PREFIX}migration/${run}/`;
  const photos=new Map(report.media.filter(row=>row.original_key.startsWith(prefix)).map(row=>[row.id,row]));
  const restoredDescriptors=new Map(), testedHouseholds=new Set();
  let after='';
  do {
    signal.throwIfAborted();
    const page=await send(`/proof-rows?after=${encodeURIComponent(after)}`);
    for(const item of page.rows) {
      const row=photos.get(item.id);
      if(!row||row.household!==item.household||restoredDescriptors.has(item.id)||kinds.some(kind=>row[`${kind}_key`]!==`${prefix}${row.household}/${row.id}/${kind}`))
        throw new Error('PhotoMigrationRestoreMismatch');
      const photo=await photoDescriptor(kit,row,row.metadata), parts=JSON.parse(item.parts);
      // Opening the sealed source proof binds every earlier byte comparison
      // to the recovered scope key. Read actual R2 bytes for each household
      // again as an independent test of the restored photo keys.
      for(const kind of kinds) {
        const check=await open(scopeKey(kit,mediaBinding(row)),parts[kind].check,partBinding(row,run,kind));
        if(!testedHouseholds.has(row.household)) {
          const reply=await send(`/proof-target/${row.id}/${kind}`,{binary:true});
          const blob=await decryptPhotoPart(await reply.arrayBuffer(),photo.crypto,row.household,row.id,kind);
          if(await hash(blob)!==check.sourceDigest)throw new Error('PhotoMigrationRestoreMismatch');
        }
      }
      testedHouseholds.add(row.household);
      restoredDescriptors.set(item.id,photo.crypto);
    }
    after=page.next;
  } while(after);
  if(!photos.size||photos.size!==restoredDescriptors.size)throw new Error('PhotoMigrationRestoreMismatch');
  for(const row of report.records) {
    signal.throwIfAborted();
    const affected=row.photoIds.filter(id=>photos.has(id));
    if(!affected.length)continue;
    const key=await recordKey(kit,privateKey,row);
    const {entry}=await open(key,row.envelope,{...bindingOf(row),kind:'document'});
    const refs=new Map(entry.photos.map(photo=>[photo.id,photo]));
    for(const id of affected)if(photos.get(id).household!==row.household||!equal(refs.get(id)?.crypto,restoredDescriptors.get(id)))
      throw new Error('PhotoMigrationRestoreMismatch');
  }
}

const labels={idle:'移行を開始できます。',photos:'写真を暗号化し、保存先から読み戻して確認しています。',
  records:'日記と写真の参照を照合しています。',ready:'準備が完了しました。次の復元確認が終わるまで日記の利用が一時停止します。',
  checking:'復元確認中です。日記の利用は一時停止しています。',done:'両世帯の切替が完了しました。'};
const messages={PhotoMigrationBusy:'別の画面で移行中です。その画面を閉じた場合は約2分後に再開できます。',
  PhotoMigrationLeaseLost:'移行の操作権限が切れました。保存済みの進捗から再開できます。',
  PhotoMigrationEntriesChanged:'日記に変更があります。再開すると参照を照合し直します。',
  PhotoMigrationCutoverConflict:'切替時に日記の変更を検出しました。再開して確認してください。',
  PhotoSourceChanged:'元写真に変更または欠落があります。保護のため中断しました。',
  PhotoMigrationGenerationChanged:'日記の鍵または移行状態が変わりました。管理者が確認するまで停止します。',
  PhotoMigrationRestoreMismatch:'復元した内容が一致しません。確認が終わるまで切替を停止します。',
  PhotoMigrationUnavailable:'移行を準備できませんでした。時間を置いて確認してください。'};

export function mountPhotoMigration({authenticate=()=>globalThis.TRoomPasskeys.authenticate('diary',links=>globalThis.TRoomPasskeys.chooseLinkDialog(links,'diary'))}={}) {
  const login=document.querySelector('#login-view'), box=document.querySelector('#existing-photo-migration-view');
  const loginButton=document.querySelector('#passkey-login'), loginMessage=document.querySelector('#login-message');
  const start=box.querySelector('#existing-photo-migration-start'), stop=box.querySelector('#existing-photo-migration-stop');
  const status=box.querySelector('[role=status]'), summary=box.querySelector('#existing-photo-migration-summary');
  const send=migrationTransport(fetch.bind(globalThis),crypto.randomUUID());
  let unlocked, active, last;
  document.querySelector('#boot-view').hidden=true;
  document.querySelector('#login-title').textContent='日記の写真移行';
  login.hidden=false;
  const showCounts=house=>{
    summary.replaceChildren(...house.map(h=>{
      const li=document.createElement('li');
      li.textContent=`${h.id==='chiharu-household'?'田中千晴':'メイン世帯'}　${h.verified.toLocaleString()} / ${h.total.toLocaleString()} 枚`;
      return li;
    }));
  };
  const render=value=>{
    last=value;
    if(value.house)showCounts(value.house);
    status.textContent=labels[value.phase]||labels.idle;
    if(value.phase==='done')status.textContent+=` 旧写真の保持期限は ${new Date(value.retainedUntil).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}（日本時間）です。`;
    start.textContent=value.phase==='idle'?'両世帯の移行を開始':value.phase==='ready'?'復元確認と切替を開始':'保存済みの進捗から再開';
    start.hidden=value.phase==='done'||(value.phase==='idle'&&value.house?.every(h=>!h.total));
    if(value.locked)status.textContent=messages.PhotoMigrationBusy;
  };
  const release = (keepalive=false) => send(root+'/release',{method:'POST',body:{},keepalive}).catch(()=>{});
  const lock = () => {active?.abort();unlocked?.kit.scopeKeys.clear();unlocked=null;};
  addEventListener('pagehide',()=>{if(active){lock();void release(true);}else lock();});
  addEventListener('pageshow',event=>{if(event.persisted&&!unlocked){box.hidden=true;login.hidden=false;}});
  document.addEventListener('troom:before-auto-update',event=>{if(active)event.preventDefault();});
  loginButton.addEventListener('click',async()=>{
    loginButton.disabled=true;loginMessage.textContent='確認中…';let auth;
    try {
      auth=await authenticate();
      const session=await send('/passkey/handoff',{method:'POST',body:{handoffToken:auth.handoff.handoffToken}});
      if(!session.isGlobalOwner||session.keySession?.identityId!=='primary-admin'||session.keySession.credentialId!==auth.credentialId)
        throw phase(403,'AccessDenied');
      const current=await send(root+'/status');
      if(current.phase==='done'||(current.phase==='idle'&&current.house.every(h=>!h.total))) {
        login.hidden=true;box.hidden=false;render(current);if(current.phase==='idle')status.textContent='移行対象の写真はありません。';return;
      }
      const [admin,own]=await Promise.all([send('/encryption/manage/admin'),send('/encryption/prepare')]);
      if(own.accountId!==session.keySession.accountId||own.webAuthnCredentialId!==auth.credentialId)throw phase(403,'AccessDenied');
      const trust=await resolveTrust({prf:auth.prfOutput,recipientId:own.recipientId,sealed:own.vault.trust,
        bootstrap:auth.handoff.diaryTrust,pinned:JSON.parse(localStorage.getItem(TRUST_PIN)||'null')});
      await checkTrustFloor(trust,localStorage);
      const directory=await verifyDirectory(admin.config.directory,trust.anchor,trust.minimumGeneration);
      const privateKey=await unlockCentralRecovery(auth.prfOutput,admin.adminEnvelope);
      const vault=await unlockVault(auth.prfOutput,own.recipientId,own.vault);
      const kit=await openRecoveryEnvelope({packet:admin.config.recoveryEnvelope,recoveryPrivateKey:privateKey,anchor:trust.anchor,minimumGeneration:directory.generation});
      kit.authority=null;
      unlocked={kit,privateKey,signingKey:vault.sign,trust,directory,recipientId:own.recipientId};
      login.hidden=true;box.hidden=false;render(current);
    }catch(error){loginMessage.textContent=error.status===403?'第一管理者の日記アカウントを選択してください。':messages[error.message]||'写真移行用の鍵を解除できませんでした。もう一度ログインしてください。';}
    finally {auth?.prfOutput?.fill(0);loginButton.disabled=false;}
  });
  stop.addEventListener('click',()=>active?.abort());
  start.addEventListener('click',async()=>{
    if(active||!unlocked)return;
    const controller=new AbortController(),signal=controller.signal;active=controller;
    const epoch=unlocked, api=(path,{signal:requestSignal=signal,...options}={})=>{
      signal.throwIfAborted();requestSignal.throwIfAborted();
      return send(root+path,{...options,signal:requestSignal});
    };
    let heartbeat, expired=false;
    start.disabled=true;stop.hidden=false;
    try {
      let job=await api('/acquire',{method:'POST',body:{}});
      heartbeat=setInterval(()=>{void api('/acquire',{method:'POST',body:{}}).catch(error=>{
        if(error.status===401||error.status===403||error.status===428){expired=true;controller.abort();}
        else if(error.status===409)controller.abort(new Error(error.message));
      });},20_000);
      if(job.phase==='photos') {
        render(await api('/status'));
        while(true) {
          const work=await api('/next');if(!work.row)break;
          await migratePhoto({...work,...epoch,run:job.run,send:api,signal});
          const household=last.house.find(h=>h.id===work.row.household);
          household.verified++;
          household.total=Math.max(household.total,household.verified);
          showCounts(last.house);
        }
      }
      if(['photos','records','ready'].includes(job.phase)) {
        job=await api('/plan',{method:'POST',body:{}});render({...last,...job});
        if(job.phase==='records') {
          while(true) {
            const work=await api('/record');if(!work.row)break;
            const row=await preparePhotoMigrationRecord({...work,...epoch});
            await api('/record',{method:'POST',body:row});
          }
          await api('/ready',{method:'POST',body:{}});
          render(await api('/status'));
          return;
        }
        job=await api('/apply',{method:'POST',body:{}});
      }
      if(job.phase==='checking') {
        render({...last,...job});
        const checkpoint=await api('/backup',{method:'POST',body:{}}),query='/backup?'+new URLSearchParams({checkpoint:checkpoint.checkpoint});
        let manifest;
        for(let attempt=0;attempt<200;attempt++) {
          manifest=await api(query);if(manifest.ready)break;
          await new Promise(resolve=>setTimeout(resolve,2000));
        }
        if(!manifest?.ready)throw new Error('PhotoMigrationBackupPending');
        const object=value=>({body:new Blob([unb64(value.bytes,24_000_000)]).stream(),customMetadata:{sha256:value.sha256}});
        let parts;
        const bucket={get:async key=>{
          if(key===checkpoint.key)return object(manifest);
          if(!parts)parts=(await new Response(object(manifest).body.pipeThrough(new DecompressionStream('gzip'))).json()).parts;
          const index=parts.findIndex(part=>part.key===key);if(index<0)throw new Error('PhotoMigrationRestoreMismatch');
          return object(await api(query+'&part='+index));
        }};
        const {restoreDiaryCheckpoint}=await import('./diary-restore.mjs');
        const report=await restoreDiaryCheckpoint({bucket,key:checkpoint.key,trust:epoch.trust,includeRecovery:true,
          wasmUrl:new URL('./vendor/sql-wasm.wasm',import.meta.url).href});
        const recovered=await openRecoveryEnvelope({packet:report.recoveryEnvelope,recoveryPrivateKey:epoch.privateKey,
          anchor:epoch.trust.anchor,minimumGeneration:epoch.directory.generation});
        recovered.authority=null;
        try {await checkPhotoMigrationRestore({report,...epoch,kit:recovered,run:job.run,sequence:job.sequence,send:api,signal});}
        finally {recovered.scopeKeys.clear();}
        await api('/finish',{method:'POST',body:await signed({run:job.run,sequence:report.sequence,checkpoint:checkpoint.checkpoint,sha256:report.archiveSha256},epoch.signingKey)});
      }
      render(await api('/status'));
    }catch(error) {
      if(expired||[401,403,428].includes(error.status)){lock();box.hidden=true;login.hidden=false;loginMessage.textContent='パスキーでログインすると、保存済みの進捗から再開できます。';}
      else status.textContent=error.name==='AbortError'?'中断しました。保存済みの進捗から再開できます。':
        messages[error.message]||(error.message==='PhotoMigrationBackupPending'?'復元用バックアップを準備中です。再開して確認してください。':'移行を中断しました。保存済みの進捗を確認して再開してください。');
    }finally {
      clearInterval(heartbeat);await release();active=null;stop.hidden=true;start.disabled=false;
    }
  });
}
