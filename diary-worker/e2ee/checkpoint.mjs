import {b64} from './crypto.mjs';
import {readRollout} from './rollout.mjs';
import {verifiedGeneration} from '../../backup-worker/src/integrity.js';
import {validateExportManifest} from '../../backup-worker/src/export-backup.js';

export async function createEncryptionCheckpoint(env,{directoryGeneration}) {
  if(String(env.DIARY_ENCRYPTION_ENABLED)!=='true')throw new Error('EncryptionDisabled');
  const control=await readRollout(env.DB);
  if(!['migrating','paused'].includes(control.phase)||!Number.isSafeInteger(directoryGeneration)||directoryGeneration<1)throw new Error('MaintenanceRequiresPausedDatabase');
  const {sequence}=await env.DB.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes').first();
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({protocol:'T-lain diary restore checkpoint',generation:control.generation,sequence,directoryGeneration}))));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes.slice(0,16)].map(b=>b.toString(16).padStart(2,'0')).join('');
  const checkpoint=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,id='diary-checkpoint-'+checkpoint;
  try{await env.D1_BACKUPS.create({id,params:{service:'diary',scheduledTime:Date.now(),checkpoint}});}
  catch{const instance=await env.D1_BACKUPS.get(id);const {status}=await instance.status();if(status==='errored')await instance.restart();else if(!['queued','running','waiting','paused','complete'].includes(status))throw new Error('DiaryCheckpointFailed');}
  return {checkpoint,instanceId:id,key:`v10/checkpoints/${checkpoint}.json.gz`};
}
export async function readEncryptionCheckpoint(env,{directoryGeneration,checkpoint,part}) {
  if(String(env.DIARY_ENCRYPTION_ENABLED)!=='true'||!Number.isSafeInteger(directoryGeneration)||directoryGeneration<1||!/^[a-f0-9-]{36}$/.test(checkpoint))throw new Error('InvalidDiaryCheckpoint');
  const control=await readRollout(env.DB);
  if(!['migrating','paused'].includes(control.phase))throw new Error('MaintenanceRequiresPausedDatabase');
  const {sequence}=await env.DB.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes').first();
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({protocol:'T-lain diary restore checkpoint',generation:control.generation,sequence,directoryGeneration}))));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes.slice(0,16)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(checkpoint!==`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`)throw new Error('DiaryCheckpointChanged');
  let key=`v10/checkpoints/${checkpoint}.json.gz`;
  const manifest=await verifiedGeneration(env.BACKUP,key,p=>validateExportManifest(p,'diary'));
  if(!manifest)return {ready:false};
  if(manifest.payload.expectedMigration!=='diary-e2ee-v1'||manifest.payload.keyMetadata.directory.value.generation!==directoryGeneration)throw new Error('DiaryCheckpointChanged');
  let object=manifest;
  if(part!==undefined) {
    if(!Number.isSafeInteger(part)||part<0||part>=manifest.payload.parts.length)throw new Error('InvalidDiaryCheckpointPart');
    const expected=manifest.payload.parts[part];key=expected.key;
    object=await verifiedGeneration(env.BACKUP,key,p=>{if(p.table!==expected.table||p.rows?.length!==expected.rowCount)throw new Error('DiaryCheckpointChanged');});
    if(!object||object.sha256!==expected.sha256||object.bytes.length!==expected.bytes)throw new Error('DiaryCheckpointChanged');
  }
  return {ready:true,key,bytes:b64(object.bytes),sha256:object.sha256};
}
