import { verifyLegacyCoverage,requireFrozenMigration } from './migration-store.mjs';
import { b64, encode, verifySigned,DIARY_READER_PROTOCOL } from './crypto.mjs';

export const READ_FORMATS = Object.freeze([1,2]);
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status}); };
const token = value => typeof value==='string' && /^[\w:-]{1,160}$/.test(value);
const digest = value => typeof value==='string' && /^[\w-]{43}$/.test(value);

export async function readRollout(db) {
  const row=await db.prepare('SELECT phase,generation,ever_encrypted,evidence FROM diary_e2ee_control WHERE id=1').first();
  if(!row||!Number.isSafeInteger(row.generation)||row.generation<0||![0,1].includes(row.ever_encrypted)||!['legacy','migrating','encrypted','paused','restoring','rekeying','purging'].includes(row.phase))fail('RolloutUnavailable',503);
  return {phase:row.phase,generation:row.generation,everEncrypted:Boolean(row.ever_encrypted),evidence:row.evidence?JSON.parse(row.evidence):null};
}

export async function writeLease(db,operation='save') {
  const control=await readRollout(db);
  if((operation==='import'?control.phase!=='migrating':control.phase!=='encrypted')||
    Number(control.evidence?.passkeyApproval?.expiresAt)>Date.now())fail('DiaryWritesPaused',423);
  return control;
}

export const leaseSQL = lease => lease ? ` AND (SELECT generation||':'||COALESCE(json_extract(evidence,'$.passkeyApprovalEpoch'),0)
  FROM diary_e2ee_control WHERE id=1)=?` : '';
export const leaseBindings = lease => lease ? [`${lease.generation}:${lease.evidence?.passkeyApprovalEpoch??0}`] : [];

export async function reservePasskeyApproval(db,id) {
  if(!/^[0-9a-f-]{36}$/.test(id))fail('InvalidPasskeyApproval',400);
  const now=Date.now(),expiresAt=now+60000;
  // Invalidate in-flight writes without invalidating existing login sessions.
  const saved=await db.prepare(`UPDATE diary_e2ee_control
    SET evidence=json_set(COALESCE(evidence,'{}'),'$.passkeyApproval',json(?),
      '$.passkeyApprovalEpoch',COALESCE(json_extract(evidence,'$.passkeyApprovalEpoch'),0)+1)
    WHERE id=1 AND phase IN ('legacy','encrypted') AND json_extract(evidence,'$.photoMigration') IS NULL
      AND COALESCE(json_extract(evidence,'$.passkeyApproval.expiresAt'),0)<=?`)
    .bind(JSON.stringify({id,expiresAt}),now).run();
  if(!saved.meta?.changes)fail('DiaryWritesPaused',423);
  return {id,expiresAt};
}

export async function releasePasskeyApproval(db,id) {
  await db.prepare(`UPDATE diary_e2ee_control SET evidence=NULLIF(json_remove(evidence,'$.passkeyApproval'),'{}')
    WHERE id=1 AND json_extract(evidence,'$.passkeyApproval.id')=?`).bind(id).run();
}

function requireOperator(actor) {
  if(!actor?.active||!actor.isGlobalOwner||!actor.credentialId)fail('AccessDenied',403);
  if(!(Number.isSafeInteger(actor.maintenanceUntil)&&actor.maintenanceUntil>Date.now()&&actor.maintenanceUntil<=Date.now()+3600000)&&(!Number.isFinite(actor.reauthenticatedAt)||Math.abs(Date.now()/1000-actor.reauthenticatedAt)>300))fail('RecentAuthenticationRequired',428);
}

// The trusted device signs evidence ONLY after source comparison and a real
// decrypt/restore drill. A caller-supplied boolean cannot enable the cutover.
async function verifyCutover(db,packet,directory,actor) {
  const rotation=await db.prepare('SELECT status,configuration FROM diary_e2ee_rotation WHERE id=1').first();
  if(rotation && (rotation.status!=='committed' || JSON.parse(rotation.configuration).directory.value.generation>directory?.generation))fail('RotationNotReady');
  const member=directory?.members.find(m=>m.credentialId===actor.credentialId&&m.accountId===actor.accountId&&m.canManageEntries);
  if(!member)fail('AccessDenied',403);
  const proof=await verifySigned(packet,member.signPublicKey);
  const control=await readRollout(db);
  if(control.phase==='migrating' && await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='diary_entries'").first()){await requireFrozenMigration(db);await verifyLegacyCoverage(db);}
  const [{results:counts},{results:sequences}]=await db.batch([
    db.prepare('SELECT COUNT(*) records FROM diary_e2ee_records'),
    db.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes')
  ]);
  if(Object.keys(proof||{}).sort().join(',')!==['protocol','version','records','sequence','directoryGeneration','sourceManifestDigest','restoreDigest','readerBuild','writerBuild','formats'].sort().join(',')||proof.protocol!=='T-lain diary cutover'||proof.version!==DIARY_READER_PROTOCOL||proof.records!==counts[0].records||proof.sequence!==sequences[0].sequence||proof.directoryGeneration!==directory.generation||!digest(proof.sourceManifestDigest)||!digest(proof.restoreDigest)||!token(proof.readerBuild)||!token(proof.writerBuild)||JSON.stringify(proof.formats)!==JSON.stringify(READ_FORMATS))fail('CutoverEvidenceMismatch');
  return proof;
}

export async function transitionRollout(db,{actor,expectedGeneration,next,evidence,directory}) {
  requireOperator(actor);
  const current=await readRollout(db);
  if(Number(current.evidence?.passkeyApproval?.expiresAt)>Date.now())fail('DiaryWritesPaused',423);
  if(current.evidence?.photoMigration)fail('PhotoMigrationChecking',423);
  if(current.generation!==expectedGeneration)fail('RolloutConflict');
  const allowed={legacy:['migrating'],migrating:['legacy','paused','encrypted'],encrypted:['paused'],paused:current.everEncrypted?['encrypted']:['legacy','migrating'],restoring:['paused']};
  if(!allowed[current.phase]?.includes(next))fail('InvalidRolloutTransition');
  let proof=current.evidence;
  if(next==='encrypted')proof=await verifyCutover(db,evidence,directory,actor);
  if(next==='encrypted'&&current.phase==='migrating'&&await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='diary_entries'").first()) {
    // Final source coverage was checked above. The write fence, plaintext D1
    // cleanup and ciphertext cutover form ONE transaction. R2 bytes and old
    // backup/Time Travel generations are never deleted by this operation.
    await db.batch([
      db.prepare("UPDATE diary_e2ee_control SET phase=CASE WHEN phase='migrating' AND generation=? AND (SELECT COUNT(*) FROM diary_e2ee_records)=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=? THEN 'purging' ELSE 'invalid-cutover' END,generation=generation+1,ever_encrypted=1,evidence=? WHERE id=1")
        .bind(expectedGeneration,proof.records,proof.sequence,JSON.stringify(proof)),
      ...['investment_history','diary_staged_photos','diary_photo_upload_sessions','diary_favorites','diary_tags','diary_trash_scopes','diary_photos','diary_entries'].map(table=>db.prepare(`DELETE FROM ${table}`)),
      db.prepare("UPDATE diary_e2ee_control SET phase='encrypted' WHERE id=1 AND phase='purging'")
    ]);
    return readRollout(db);
  }
  const hasUploads=current.phase==='legacy'&&next==='migrating'&&await db.prepare("SELECT 1 found FROM sqlite_schema WHERE type='table' AND name='diary_photo_upload_sessions'").first();
  const result=await db.prepare(`UPDATE diary_e2ee_control SET phase=?,generation=generation+1,ever_encrypted=CASE WHEN ?='encrypted' THEN 1 ELSE ever_encrypted END,evidence=? WHERE id=1 AND generation=? AND phase=? ${next==='encrypted'?'AND (SELECT COUNT(*) FROM diary_e2ee_records)=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=?':''} ${hasUploads?"AND NOT EXISTS (SELECT 1 FROM diary_photo_upload_sessions WHERE status='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))":''}`)
    .bind(next,next,proof?JSON.stringify(proof):null,expectedGeneration,current.phase,...(next==='encrypted'?[proof.records,proof.sequence]:[])).run();
  if(result.meta.changes!==1)fail('RolloutConflict');
  return readRollout(db);
}

// Planning does not promote a Cloudflare version. Pause, validate an explicitly
// retained encrypted reader, then use the existing operator release mechanism.
export function rollbackPlan(control,stable) {
  if(!stable||!token(stable.build)||!token(stable.workerVersion)||!Array.isArray(stable.formats)||READ_FORMATS.some(format=>!stable.formats.includes(format))||stable.protocol!==DIARY_READER_PROTOCOL)fail('IncompatibleRollbackTarget');
  return {requiresPause:true,sourceGeneration:control.generation,workerVersion:stable.workerVersion,build:stable.build,dataAction:'preserve-ciphertext',resumePhase:control.everEncrypted?'encrypted':'legacy'};
}

export async function checkpointDigest(snapshot) {
  return b64(await crypto.subtle.digest('SHA-256',encode(snapshot)));
}
