import {verifyDirectory,encode,b64,validateEnvelope} from '../../diary-worker/e2ee/crypto.mjs';
import {validateKeyMetadata} from '../../diary-worker/e2ee/backup.mjs';
import {verifyRecord} from '../../diary-worker/e2ee/record.mjs';
import {parseRecord} from '../../diary-worker/e2ee/store.mjs';
export const DIARY_ENCRYPTED_MIGRATION='diary-e2ee-v1';
export const SECURITY_DIARY_MIGRATION='security-diary-keys-v1';
const table=(name,columns)=>({name,columns:columns.split(','),sourceColumns:columns});
export const ENCRYPTED_DIARY_TABLES=[
  table('diary_e2ee_control','id,phase,generation,ever_encrypted,evidence'),
  table('diary_e2ee_records','id,household,scope,state,author,revision,epoch,source_id,source_revision,retained_for,envelope,summary,photo_ids,request_id,mutation_id,key_box,attestation'),
  table('diary_e2ee_changes','seq,id,household,revision,deleted'),
  table('diary_e2ee_requests','household,account_id,request_id,fingerprint,result'),
  table('diary_e2ee_media_gc','photo_id,household,mutation_id'),
  table('diary_e2ee_media','id,household,account_id,session_id,status,original_key,display_key,thumbnail_key,metadata,epoch,request_hash,expires_at,retired_at'),
  table('diary_e2ee_uploads','id,household,account_id,target_id,status,expires_at,committed_entry,committed_ids'),
];
export const SECURITY_DIARY_TABLES=[
  table('security_diary_key_config','id,generation,anchor_json,directory_json,recovery_json'),
  table('security_diary_key_vaults','recipient_id,credential_id,identity_id,service_link_id,account_id,vault_json'),
  table('security_diary_key_grants','recipient_id,service_link_id,generation,grants_json,record_grants_json'),
];
export const sameKeyMetadata=(a,b)=>b64(encode(a))===b64(encode(b));
export async function readDiaryKeyMetadata(db) {
  if(!db)throw new Error('DiaryKeyMetadataUnavailable');
  const [configs,vaults,grants]=await db.batch([
    db.prepare('SELECT * FROM security_diary_key_config WHERE id=1'),
    db.prepare("SELECT * FROM security_diary_key_vaults WHERE recipient_id IN (SELECT json_extract(member.value,'$.credentialId') FROM security_diary_key_config c,json_each(c.directory_json,'$.value.members') member WHERE c.id=1)"),
    db.prepare('SELECT * FROM security_diary_key_grants WHERE generation=(SELECT generation FROM security_diary_key_config WHERE id=1)'),
  ]);
  const config=configs.results[0];if(!config)throw new Error('DiaryKeyMetadataUnavailable');
  const {delegation,...recoveryEnvelope}=JSON.parse(config.recovery_json);
  const metadata={anchor:JSON.parse(config.anchor_json),directory:JSON.parse(config.directory_json),recoveryEnvelope,
    ...(delegation?{delegation}:{}),vaults:{},grants:{},recordGrants:{}};
  const directory=await verifyDirectory(metadata.directory,metadata.anchor,config.generation);
  if(directory.generation!==config.generation)throw new Error('DiaryKeyGenerationConflict');
  for(const member of directory.members) {
    const vault=vaults.results.find(row=>row.recipient_id===member.credentialId&&row.account_id===member.accountId);
    const grant=grants.results.find(row=>row.recipient_id===member.credentialId&&row.service_link_id===member.serviceLinkId&&row.generation===directory.generation);
    if(!vault||!grant)throw new Error('IncompleteDiaryKeyMetadata');
    metadata.vaults[member.credentialId]=JSON.parse(vault.vault_json);
    metadata.grants[member.credentialId]=JSON.parse(grant.grants_json);
    metadata.recordGrants[member.credentialId]=JSON.parse(grant.record_grants_json);
    if(!sameKeyMetadata(metadata.vaults[member.credentialId].publicKey,member.publicKey)||!sameKeyMetadata(metadata.vaults[member.credentialId].signPublicKey,member.signPublicKey))throw new Error('InvalidDiaryKeyMetadata');
  }
  await validateKeyMetadata(metadata,directory,metadata.anchor);
  return metadata;
}
export async function verifyEncryptedDiaryRow(table,row,directory) {
  if(table==='diary_e2ee_records')await verifyRecord(parseRecord(row),directory);
  if(table==='diary_e2ee_control'&&!(row.ever_encrypted&&['encrypted','paused'].includes(row.phase)||!row.ever_encrypted&&row.phase==='migrating'))throw new Error('DiaryBackupRequiresEncryptedSnapshot');
  if(table==='diary_e2ee_media') {
    validateEnvelope(JSON.parse(row.metadata));
    if(row.epoch!==directory.epochs[`${row.household}:preferences:${row.account_id}`])throw new Error('DiaryKeyGenerationConflict');
  }
}
