import {unlockCentralRecovery} from './crypto/e2ee/tcloud-recovery.mjs';
import {unlockVault,unb64,verifyDirectory} from './crypto/e2ee/crypto.mjs';
import {openMaintenancePlans,prepareDiaryMaintenance,finishDiaryMaintenance} from './crypto/e2ee/maintenance.mjs';
import {rotationDigest} from './crypto/e2ee/rotation.mjs';

// Runs inside the ordinary owner login, using that ceremony's PRF. The scoped
// continuation stays in memory and is never a replacement login or key grant.
export async function migrateDiaryOnLogin({api,session,authentication,trust,check,onProgress=()=>{}}) {
  let authorization,plans;
  const manage=async(path,body)=>{
    check();
    const value=await api('/encryption/manage'+path,{...(body===undefined?{}:{method:'POST',body}),...(authorization?{headers:{'X-Diary-Maintenance':authorization}}:{})});check();
    if(path==='/control'&&body?.next==='migrating')authorization=(await manage('/maintenance/authorize',{})).authorization;
    return value;
  };
  const status=await manage('/admin');
  if(!status.config||!trust||!['legacy','migrating','encrypted'].includes(status.rollout.phase))return;
  await verifyDirectory(status.config.directory,trust.anchor,trust.minimumGeneration);
  if(status.rollout.phase==='encrypted') {
    // Cleanup after a successful cutover whose response was lost is optional
    // for normal use; unavailable device storage must not block a later login.
    try {
      plans=await openMaintenancePlans();
      const pending=await plans.get();
      if(pending?.kind==='migration'&&status.rollout.evidence?.sourceManifestDigest===await rotationDigest(pending))await plans.clear();
    }catch{/* Normal encrypted login needs no maintenance storage. */}
    finally{plans?.close();}
    return;
  }
  try {
    plans=await openMaintenancePlans();
    // Verify both existing keys before placing the write fence. Neither a
    // missing recovery envelope nor a mismatching signer may freeze Diary.
    const recoveryPrivateKey=await unlockCentralRecovery(authentication.prfOutput,status.adminEnvelope);check();
    const signing=await manage('/maintenance/signing-vault',{});
    if(signing.accountId!==session.encryption.accountId)throw new Error('DiaryAutomaticSignerMismatch');
    const ownKeys=await unlockVault(authentication.prfOutput,signing.recipientId,signing.vault);check();
    authentication.diaryPrivateKeys=ownKeys;
    authentication.prfOutput.fill(0);
    if(status.rollout.phase==='migrating')authorization=(await manage('/maintenance/authorize',{})).authorization;
    authentication.diaryMigrationStarted=true;
    onProgress({phase:'reading',completed:0});
    await prepareDiaryMaintenance({kind:'migration',api:manage,recoveryPrivateKey,trust,plans,onProgress});
    const checkpoint=await manage('/maintenance/backup',{});
    let manifest;
    for(let attempt=0;attempt<300;attempt++) {
      manifest=await manage('/maintenance/checkpoint?'+new URLSearchParams({checkpoint:checkpoint.checkpoint}));
      if(manifest.ready)break;
      onProgress({phase:'backup',completed:attempt});
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    if(!manifest?.ready)throw new Error('バックアップの準備が続いています。次回の日記ログイン時に自動で再開します。');
    const {restoreDiaryCheckpoint}=await import('./diary-restore.mjs');
    let parts;
    const object=value=>({body:new Blob([unb64(value.bytes,24_000_000)]).stream(),customMetadata:{sha256:value.sha256}});
    const bucket={get:async key=>{
      if(key===checkpoint.key)return object(manifest);
      if(!parts)parts=(await new Response(object(manifest).body.pipeThrough(new DecompressionStream('gzip'))).json()).parts;
      const part=parts.findIndex(value=>value.key===key);if(part<0)throw new Error('InvalidCheckpointPart');
      return object(await manage('/maintenance/checkpoint?'+new URLSearchParams({checkpoint:checkpoint.checkpoint,part})));
    }};
    const report=await restoreDiaryCheckpoint({bucket,key:checkpoint.key,trust,onProgress,wasmUrl:new URL('./vendor/sql-wasm.wasm',import.meta.url).href});
    const {build}=await manage('/maintenance/build');
    await finishDiaryMaintenance({api:manage,recoveryPrivateKey,signingKey:ownKeys.sign,trust,plans,report,readerBuild:build,writerBuild:build});
    onProgress({phase:'complete'});
  }catch(error) {
    authentication.diaryPrivateKeys=null;
    throw Object.assign(error,{migrationPending:true});
  }finally{authorization=null;plans?.close();}
}
