import {DIARY_READER_PROTOCOL,encode,fingerprint,verifyDirectory,verifySigned,validateEnvelope} from './crypto.mjs';
import {verifyRecord} from './record.mjs';
import {LEGACY_TABLES,prepareMigration} from './migration.mjs';
import {prepareRotation,rotationDigest} from './rotation.mjs';

// Only sealed plans are durable. The caller unlocks the existing recovery key
// on the trusted device and supplies an authenticated Security Center API.
export async function openMaintenancePlans(name='tlain-diary-maintenance-v1') {
  const request=indexedDB.open(name,1);
  request.onupgradeneeded=()=>request.result.createObjectStore('plans');
  const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('MaintenanceStorageUnavailable'));});
  const operation=(mode,callback)=>new Promise((resolve,reject)=>{
    const tx=db.transaction('plans',mode,{durability:'strict'}),req=callback(tx.objectStore('plans'));
    tx.oncomplete=()=>resolve(req.result);tx.onerror=tx.onabort=()=>reject(new Error('MaintenanceStorageUnavailable'));
  });
  return {get:()=>operation('readonly',store=>store.get('pending')),put:plan=>operation('readwrite',store=>{store.delete('progress');return store.put(plan,'pending');}),getProgress:()=>operation('readonly',store=>store.get('progress')),putProgress:progress=>operation('readwrite',store=>store.put(progress,'progress')),clear:()=>operation('readwrite',store=>{store.delete('progress');return store.delete('pending');}),getInvestment:()=>operation('readonly',store=>store.get('investment')),putInvestment:plan=>operation('readwrite',store=>store.put(plan,'investment')),clearInvestment:()=>operation('readwrite',store=>store.delete('investment')),close:()=>db.close()};
}
const message=()=>new Error('前回の移行と一致しません。保存済みの移行情報を保持して管理者に確認してください。');
async function validatePlan(plan,anchor,directory) {
  if(encode(plan).length>100_000_000||plan.anchorFingerprint!==await fingerprint(anchor)||!Array.isArray(plan.records)||!Array.isArray(plan.media))throw message();
  for(const row of plan.records)await verifyRecord(row,directory);
  for(const row of plan.media)validateEnvelope(JSON.parse(row.metadata));
}
export function* maintenanceBatches(rows) {
  let batch=[],bytes=0;
  for(const row of rows){const size=encode(row).length;if(size>1_800_000)throw new Error('MaintenanceRecordBudgetExceeded');
    if(batch.length&&(batch.length===20||bytes+size>1_800_000)){yield batch;batch=[];bytes=0;}
    batch.push(row);bytes+=size;}
  if(batch.length)yield batch;
}
export async function prepareDiaryMaintenance({kind,api,recoveryPrivateKey,trust,plans,onProgress=()=>{}}) {
  if(!['migration','rotation'].includes(kind))throw message();
  let status=await api('/admin');
  if(kind==='migration'&&status.writerReadiness?.ready===false)throw new Error('先に日記を利用する全員の鍵の準備と管理者承認を完了してください。');
  await verifyDirectory(status.config.directory,trust.anchor,trust.minimumGeneration);
  let plan=await plans.get();
  if(plan&&plan.kind!==kind)throw message();
  if(plan) {
    const directory=kind==='rotation'?await verifyDirectory(plan.configuration.directory,trust.anchor):status.config.directory.value;
    await validatePlan(plan,trust.anchor,directory);
    if(kind==='migration'&&(plan.directoryGeneration!==status.config.generation||plan.rolloutGeneration!==status.rollout.generation))throw message();
    if(kind==='rotation'&&status.config.generation<plan.configuration.expectedGeneration)throw message();
  } else {
    const target=kind==='migration'?'migrating':'paused';
    if(status.rollout.phase!==target) {
      if(kind==='migration'&&status.rollout.phase!=='legacy'||kind==='rotation'&&status.rollout.phase!=='encrypted')throw message();
      await api('/control',{expectedGeneration:status.rollout.generation,next:target,evidence:null});
      status=await api('/admin');
    }
    let prepared;
    if(kind==='migration') {
      const source={};let totalBytes=0;
      for(const table of LEGACY_TABLES) {
        source[table]=[];let after=0;
        do {
          const page=await api('/migration/inventory?'+new URLSearchParams({table,after}));
          if(page.controlGeneration!==status.rollout.generation)throw message();
          totalBytes+=encode(page.rows).length;if(totalBytes>50_000_000)throw new Error('MigrationSourceBudgetExceeded');
          source[table].push(...page.rows);after=page.nextCursor;
          onProgress({phase:'reading',completed:source[table].length});
        }while(after!==null);
      }
      prepared=await prepareMigration({source,configuration:status.config,recoveryPrivateKey,trustedAnchor:trust.anchor});
    } else {
      const inventory={records:[],media:[]};let sequence;
      for(const type of ['records','media']) {
        let after='';
        do {
          const page=await api('/rotation/inventory?'+new URLSearchParams({kind:type,after}));
          if(page.controlGeneration!==status.rollout.generation||sequence!==undefined&&sequence!==page.sequence)throw message();
          sequence=page.sequence;inventory[type].push(...page.rows);after=page.nextCursor;
          if(encode(inventory).length>50_000_000)throw new Error('RotationSourceBudgetExceeded');
          onProgress({phase:'reading',completed:inventory[type].length});
        }while(after);
      }
      prepared=await prepareRotation({status,recoveryPrivateKey,trustedAnchor:trust.anchor,...inventory});
    }
    plan={kind,directoryGeneration:status.config.generation,rolloutGeneration:status.rollout.generation,anchorFingerprint:await fingerprint(trust.anchor),...prepared};
    await validatePlan(plan,trust.anchor,plan.configuration?.directory.value||status.config.directory.value);
    // Failure to durably retain the exact ciphertext stops before any import.
    await plans.put(plan);
  }
  const digest=await rotationDigest(plan),savedProgress=await plans.getProgress?.();
  const progress=savedProgress?.digest===digest?savedProgress:{digest,records:0,media:0};
  for(const type of ['records','media'])if(!Number.isSafeInteger(progress[type])||progress[type]<0||progress[type]>plan[type].length)throw message();
  if(kind==='rotation') {
    await verifySigned(plan.manifest,trust.anchor);
    const run=await api('/rotation/status');
    if(run?.status!=='committed'||await rotationDigest(run.manifest)!==await rotationDigest(plan.manifest)) {
      if(status.config.generation!==plan.configuration.expectedGeneration)throw message();
      const begun=await api('/rotation/begin',{configuration:plan.configuration,manifest:plan.manifest});
      if(!begun.resumed){progress.records=0;progress.media=0;await plans.putProgress?.(progress);}
      for(const type of ['records','media']){let completed=progress[type];for(const rows of maintenanceBatches(plan[type].slice(completed))) {
        await api('/rotation/stage',{kind:type,rows});completed+=rows.length;progress[type]=completed;await plans.putProgress?.(progress);
        onProgress({phase:'writing',completed,total:plan[type].length});
      }
      }
      await api('/rotation/commit',{manifestDigest:await rotationDigest(plan.manifest)});
    }
    if(status.config.generation===plan.configuration.expectedGeneration)await api('/config',plan.configuration);
  } else for(const type of ['records','media']){let completed=progress[type];for(const rows of maintenanceBatches(plan[type].slice(completed))) {
    await api('/migration/import',{kind:type,rows,expectedGeneration:plan.rolloutGeneration});completed+=rows.length;progress[type]=completed;await plans.putProgress?.(progress);
    onProgress({phase:'writing',completed,total:plan[type].length});
  }}
  return {requiresRestoreDrill:true,kind,records:plan.records.length,media:plan.media.length,directoryGeneration:plan.configuration?.directory.value.generation||plan.directoryGeneration};
}

// The report contains only rows read from the isolated restored database. The
// trusted device compares the COMPLETE inventory, decrypts every document,
// summary and media envelope, then signs the normal cutover evidence.
export async function finishDiaryMaintenance({api,recoveryPrivateKey,signingKey,trust,plans,report,readerBuild,writerBuild}) {
  const plan=await plans.get();if(!plan)throw message();
  const status=await api('/admin'),directory=await verifyDirectory(status.config.directory,trust.anchor,trust.minimumGeneration);
  const {open,openRecipientKey,signed}=await import('./crypto.mjs');
  const {bindingOf}=await import('./record.mjs');
  const {openRecoveryEnvelope}=await import('./recovery.mjs');
  const {mediaBinding,rotationInventoryDigest}=await import('./rotation.mjs');
  if(report?.protocol!=='T-lain diary isolated restore'||report.version!==1||report.directoryGeneration!==directory.generation||!Array.isArray(report.records)||!Array.isArray(report.media)||!Number.isSafeInteger(report.sequence)||report.sequence<0||!/^[a-f0-9]{64}$/.test(report.archiveSha256)||encode(report).length>100_000_000)throw message();
  const sourceManifestDigest=await rotationDigest(plan),restoreDigest=await rotationDigest(report);
  if(status.rollout.phase==='encrypted'&&status.rollout.evidence?.sourceManifestDigest===sourceManifestDigest&&status.rollout.evidence?.restoreDigest===restoreDigest){await plans.clear();return {completed:true};}
  const current={records:[],media:[]};
  for(const kind of ['records','media']) {
    let after='';
    do {
      const page=await api('/maintenance/inventory?'+new URLSearchParams({kind,after}));
      if(page.controlGeneration!==status.rollout.generation||page.sequence!==report.sequence||page.total!==report[kind].length||page.total>100000)throw message();
      current[kind].push(...page.rows);after=page.nextCursor;
      if(encode(current).length>100_000_000)throw new Error('MaintenanceBudgetExceeded');
    }while(after);
    const digest=async rows=>rotationInventoryDigest(await Promise.all(rows.map(async row=>({id:row.id,digest:await rotationDigest(row)}))));
    if(current[kind].length!==report[kind].length||await digest(current[kind])!==await digest(report[kind])||await digest(plan[kind])!==await digest(report[kind]))throw new Error('RestoreInventoryMismatch');
  }
  const kit=await openRecoveryEnvelope({packet:status.config.recoveryEnvelope,recoveryPrivateKey,anchor:trust.anchor,minimumGeneration:directory.generation});
  try {
    for(const row of report.records) {
      await verifyRecord(row,directory);const binding=bindingOf(row);
      const key=Object.keys(row.keyBox).length?await openRecipientKey(row.keyBox,{...binding,kind:'record-key'},'__recovery__',recoveryPrivateKey):kit.scopeKeys.get(row.scope);
      const document=await open(key,row.envelope,{...binding,kind:'document'});
      await open(key,row.summary,{...binding,kind:'summary'});
      if(document.version!==1||!document.entry)throw new Error('UnsupportedPayload');
    }
    for(const row of report.media)await open(kit.scopeKeys.get(mediaBinding(row).scope),JSON.parse(row.metadata),mediaBinding(row));
  }finally{kit.scopeKeys.clear();kit.authority=null;}
  const evidence=await signed({protocol:'T-lain diary cutover',version:DIARY_READER_PROTOCOL,records:report.records.length,sequence:report.sequence,directoryGeneration:directory.generation,
    sourceManifestDigest,restoreDigest,readerBuild,writerBuild,formats:[1,2]},signingKey);
  await api('/control',{expectedGeneration:status.rollout.generation,next:'encrypted',evidence});
  await plans.clear();return {completed:true};
}
