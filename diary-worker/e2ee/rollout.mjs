import { b64, encode, verifySigned } from './crypto.mjs';

export const READ_FORMATS = Object.freeze([1,2]);
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status}); };
const token = value => typeof value==='string' && /^[\w:-]{1,160}$/.test(value);
const digest = value => typeof value==='string' && /^[\w-]{43}$/.test(value);

export async function readRollout(db) {
  const row=await db.prepare('SELECT phase,generation,ever_encrypted,evidence FROM diary_e2ee_control WHERE id=1').first();
  if(!row||!Number.isSafeInteger(row.generation)||row.generation<0||![0,1].includes(row.ever_encrypted)||!['legacy','migrating','encrypted','paused','restoring'].includes(row.phase))fail('RolloutUnavailable',503);
  return {phase:row.phase,generation:row.generation,everEncrypted:Boolean(row.ever_encrypted),evidence:row.evidence?JSON.parse(row.evidence):null};
}

export async function writeLease(db,operation='save') {
  const control=await readRollout(db);
  if(operation==='import'?control.phase!=='migrating':control.phase!=='encrypted')fail('DiaryWritesPaused',423);
  return control;
}

export const leaseSQL = lease => lease ? ' AND (SELECT generation FROM diary_e2ee_control WHERE id=1)=?' : '';

function requireOperator(actor) {
  if(!actor?.active||!actor.isGlobalOwner||!actor.credentialId)fail('AccessDenied',403);
  if(!Number.isFinite(actor.reauthenticatedAt)||Math.abs(Date.now()/1000-actor.reauthenticatedAt)>300)fail('RecentAuthenticationRequired',428);
}

// The trusted device signs evidence ONLY after source comparison and a real
// decrypt/restore drill. A caller-supplied boolean cannot enable the cutover.
async function verifyCutover(db,packet,directory,actor) {
  const member=directory?.members.find(m=>m.credentialId===actor.credentialId&&m.accountId===actor.accountId&&m.canManageEntries);
  if(!member)fail('AccessDenied',403);
  const proof=await verifySigned(packet,member.signPublicKey);
  const [{results:counts},{results:sequences}]=await db.batch([
    db.prepare('SELECT COUNT(*) records FROM diary_e2ee_records'),
    db.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes')
  ]);
  if(Object.keys(proof||{}).sort().join(',')!==['protocol','version','records','sequence','directoryGeneration','sourceManifestDigest','restoreDigest','readerBuild','writerBuild','formats'].sort().join(',')||proof.protocol!=='T-lain diary cutover'||proof.version!==1||proof.records!==counts[0].records||proof.sequence!==sequences[0].sequence||proof.directoryGeneration!==directory.generation||!digest(proof.sourceManifestDigest)||!digest(proof.restoreDigest)||!token(proof.readerBuild)||!token(proof.writerBuild)||JSON.stringify(proof.formats)!==JSON.stringify(READ_FORMATS))fail('CutoverEvidenceMismatch');
  return proof;
}

export async function transitionRollout(db,{actor,expectedGeneration,next,evidence,directory}) {
  requireOperator(actor);
  const current=await readRollout(db);
  if(current.generation!==expectedGeneration)fail('RolloutConflict');
  const allowed={legacy:['migrating'],migrating:['legacy','paused','encrypted'],encrypted:['paused'],paused:current.everEncrypted?['encrypted']:['legacy','migrating'],restoring:['paused']};
  if(!allowed[current.phase].includes(next))fail('InvalidRolloutTransition');
  let proof=current.evidence;
  if(next==='encrypted')proof=await verifyCutover(db,evidence,directory,actor);
  const result=await db.prepare(`UPDATE diary_e2ee_control SET phase=?,generation=generation+1,ever_encrypted=CASE WHEN ?='encrypted' THEN 1 ELSE ever_encrypted END,evidence=? WHERE id=1 AND generation=? AND phase=? ${next==='encrypted'?'AND (SELECT COUNT(*) FROM diary_e2ee_records)=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=?':''}`)
    .bind(next,next,proof?JSON.stringify(proof):null,expectedGeneration,current.phase,...(next==='encrypted'?[proof.records,proof.sequence]:[])).run();
  if(result.meta.changes!==1)fail('RolloutConflict');
  return readRollout(db);
}

// Planning does not promote a Cloudflare version. Pause, validate an explicitly
// retained encrypted reader, then use the existing operator release mechanism.
export function rollbackPlan(control,stable) {
  if(!stable||!token(stable.build)||!token(stable.workerVersion)||!Array.isArray(stable.formats)||READ_FORMATS.some(format=>!stable.formats.includes(format))||stable.protocol!==1)fail('IncompatibleRollbackTarget');
  return {requiresPause:true,sourceGeneration:control.generation,workerVersion:stable.workerVersion,build:stable.build,dataAction:'preserve-ciphertext',resumePhase:control.everEncrypted?'encrypted':'legacy'};
}

export async function checkpointDigest(snapshot) {
  return b64(await crypto.subtle.digest('SHA-256',encode(snapshot)));
}
