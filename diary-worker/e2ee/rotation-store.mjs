import {rotationInventoryDigest} from './rotation.mjs';
import { b64,encode,verifyDirectory,verifySigned } from './crypto.mjs';
import { verifyRecord,bindingOf } from './record.mjs';
import { parseRecord } from './store.mjs';
import { readRollout } from './rollout.mjs';
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
const hash=async value=>b64(await crypto.subtle.digest('SHA-256',encode(value)));
const equal=(a,b)=>b64(encode(a))===b64(encode(b));
const exact=(v,keys)=>v&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
async function frozen(db) {
  const control=await readRollout(db);
  if(control.phase!=='paused'||!control.everEncrypted)fail('RotationRequiresPausedDatabase');
  const {sequence}=await db.prepare('SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes').first();
  return {...control,sequence};
}
export async function rotationStatus(db) {
  const row=await db.prepare('SELECT * FROM diary_e2ee_rotation WHERE id=1').first();
  return row?{status:row.status,manifest:JSON.parse(row.manifest),configuration:JSON.parse(row.configuration),controlGeneration:row.control_generation,sequence:row.sequence}:null;
}
export async function rotationInventory(db,{after='',kind='records',limit=20}={}) {
  const control=await frozen(db);
  if(!['records','media'].includes(kind)||typeof after!=='string'||after.length>160||!Number.isInteger(limit)||limit<1||limit>20)fail('InvalidRotationPage');
  const table=kind==='records'?'diary_e2ee_records':'diary_e2ee_media';
  const rows=(await db.prepare(`SELECT * FROM ${table} WHERE id>? ORDER BY id LIMIT ?`).bind(after,limit+1).all()).results;
  const page=rows.slice(0,limit);
  return {controlGeneration:control.generation,sequence:control.sequence,rows:kind==='records'?page.map(parseRecord):page,nextCursor:rows.length>limit?page.at(-1).id:null};
}
export async function beginRotation(db,{configuration,manifest,anchor,currentDirectory}) {
  const control=await frozen(db),proof=await verifySigned(manifest,anchor);
  const existing=await rotationStatus(db);
  if(existing&&equal(existing.manifest,manifest)&&equal(existing.configuration,configuration))return existing;
  if(encode({configuration,manifest}).length>1_800_000)fail('RotationManifestBudgetExceeded');
  const next=await verifyDirectory(configuration.directory,anchor,currentDirectory.generation+1);
  if(!exact(proof,['protocol','version','sourceGeneration','targetGeneration','directoryDigest','configurationDigest','records','media'])||
      proof.protocol!=='T-lain diary rotation'||proof.version!==1||proof.sourceGeneration!==currentDirectory.generation||
      proof.targetGeneration!==next.generation||next.generation!==currentDirectory.generation+1||
      proof.directoryDigest!==await hash(configuration.directory)||proof.configurationDigest!==await hash(configuration)||
      !equal(next.recoveryAuthority,anchor))
    fail('InvalidRotationManifest');
  for(const kind of ['records','media']) {
    const inventory=proof[kind];
    if(!exact(inventory,['count','digest'])||!Number.isSafeInteger(inventory.count)||inventory.count<0||inventory.count>(kind==='records'?5000:100000)||typeof inventory.digest!=='string'||!/^[\w-]{43}$/.test(inventory.digest))fail('InvalidRotationManifest');
    const count=await db.prepare(`SELECT COUNT(*) count FROM diary_e2ee_${kind}`).first();
    if(count.count!==inventory.count)fail('IncompleteRotationInventory');
  }
  // Constraint failure aborts the transaction if a resume raced this freeze.
  await db.batch([
    db.prepare('DELETE FROM diary_e2ee_rotation_items'),
    db.prepare('DELETE FROM diary_e2ee_rotation'),
    db.prepare(`INSERT INTO diary_e2ee_rotation SELECT 1,?,?,'staging',CASE WHEN phase='paused' AND generation=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=? THEN generation ELSE -1 END,? FROM diary_e2ee_control WHERE id=1`)
      .bind(JSON.stringify(manifest),JSON.stringify(configuration),control.generation,control.sequence,control.sequence),
  ]);
  return rotationStatus(db);
}
export async function stageRotation(db,{kind,rows,anchor}) {
  const control=await frozen(db),run=await rotationStatus(db);
  if(!run||run.status!=='staging'||run.controlGeneration!==control.generation||run.sequence!==control.sequence)fail('RotationCheckpointChanged');
  if(!['records','media'].includes(kind)||!Array.isArray(rows)||rows.length<1||rows.length>20||encode(rows).length>2_000_000)fail('InvalidRotationBatch');
  const next=await verifyDirectory(run.configuration.directory,anchor),manifest=run.manifest.value;
  const statements=[];
  for(const row of rows) {
    const raw=await db.prepare(`SELECT * FROM diary_e2ee_${kind} WHERE id=?`).bind(row.id).first();
    const old=kind==='records'?parseRecord(raw):raw;
    if(!old)fail('RotationSourceChanged');
    const previousDigest=await hash(old);
    if(kind==='records') {
      await verifyRecord(row,next);
      if(!equal({...bindingOf(old),revision:row.revision,epoch:row.epoch},bindingOf(row))||row.revision!==old.revision+1||
          row.epoch!==(run.configuration.directory.value.epochs[row.scope])||
          row.attestation.recovery?.previousDigest!==previousDigest||
          row.attestation.recovery?.previousGeneration!==manifest.sourceGeneration)fail('RotationRecordChanged');
    }else if(!equal({...old,epoch:row.epoch,metadata:row.metadata},row)||row.epoch!==next.epochs[`${row.household}:preferences:${row.account_id}`])fail('RotationMediaChanged');
    // Retries only accept the exact signed ciphertext. R2 keys are immutable.
    statements.push(db.prepare(`INSERT INTO diary_e2ee_rotation_items(kind,id,payload,previous_digest) SELECT ?,?,?,? WHERE (SELECT generation FROM diary_e2ee_control WHERE id=1)=? ON CONFLICT(kind,id) DO UPDATE SET payload=CASE WHEN payload=excluded.payload THEN payload ELSE NULL END`)
      .bind(kind,row.id,JSON.stringify(row),previousDigest,control.generation));
  }
  const result=await db.batch(statements);
  if(result.some(r=>r.meta.changes!==1))fail('RotationCheckpointChanged');
  return {staged:rows.length};
}
export async function commitRotation(db,{manifestDigest}) {
  const control=await frozen(db),run=await rotationStatus(db);
  if(!run||await hash(run.manifest)!==manifestDigest)fail('RotationManifestMismatch');
  if(run.status==='committed')return run;
  if(run.controlGeneration!==control.generation||run.sequence!==control.sequence)fail('RotationCheckpointChanged');
  for(const kind of ['records','media']) {
    const descriptors=[];let after='';
    while(true) {
      const rows=(await db.prepare('SELECT id,payload,previous_digest FROM diary_e2ee_rotation_items WHERE kind=? AND id>? ORDER BY id LIMIT 50').bind(kind,after).all()).results;
      if(!rows.length)break;
      for(const row of rows)descriptors.push({id:row.id,digest:await hash(JSON.parse(row.payload)),previousDigest:row.previous_digest});
      if(descriptors.length>run.manifest.value[kind].count)fail('IncompleteRotation');
      after=rows.at(-1).id;
    }
    if(descriptors.length!==run.manifest.value[kind].count)fail('IncompleteRotation');
    if(await rotationInventoryDigest(descriptors)!==run.manifest.value[kind].digest)fail('RotationDigestMismatch');
  }
  const recordCount=run.manifest.value.records.count,mediaCount=run.manifest.value.media.count;
  const guard=`phase='paused' AND generation=? AND (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes)=? AND (SELECT COUNT(*) FROM diary_e2ee_records)=? AND (SELECT COUNT(*) FROM diary_e2ee_media)=? AND (SELECT COUNT(*) FROM diary_e2ee_rotation_items)=?`;
  const source=column=>`(SELECT json_extract(payload,'$.${column}') FROM diary_e2ee_rotation_items WHERE kind='records' AND id=diary_e2ee_records.id)`;
  await db.batch([
    db.prepare(`UPDATE diary_e2ee_control SET phase=CASE WHEN ${guard} THEN 'rekeying' ELSE 'invalid-rotation' END,generation=generation+1 WHERE id=1`).bind(control.generation,control.sequence,recordCount,mediaCount,recordCount+mediaCount),
    db.prepare(`UPDATE diary_e2ee_records SET revision=${source('revision')},epoch=${source('epoch')},envelope=${source('envelope')},summary=${source('summary')},key_box=${source('keyBox')},attestation=${source('attestation')}`),
    db.prepare(`UPDATE diary_e2ee_media SET epoch=(SELECT json_extract(payload,'$.epoch') FROM diary_e2ee_rotation_items WHERE kind='media' AND id=diary_e2ee_media.id),metadata=(SELECT json_extract(payload,'$.metadata') FROM diary_e2ee_rotation_items WHERE kind='media' AND id=diary_e2ee_media.id)`),
    db.prepare('DELETE FROM diary_e2ee_requests'),
    db.prepare("UPDATE diary_e2ee_rotation SET status='committed' WHERE id=1"),
    db.prepare("DELETE FROM diary_e2ee_rotation_items"),
    db.prepare("UPDATE diary_e2ee_control SET phase='paused' WHERE id=1 AND phase='rekeying'"),
  ]);
  return rotationStatus(db);
}

export async function maintenanceInventory(db,{kind='records',after='',limit=20}={}) {
  const control=await readRollout(db);
  if(!['migrating','paused'].includes(control.phase))fail('MaintenanceRequiresPausedDatabase');
  if(!['records','media'].includes(kind)||typeof after!=='string'||after.length>160||!Number.isInteger(limit)||limit<1||limit>20)fail('InvalidMaintenancePage');
  const [head,result]=await db.batch([
    db.prepare(`SELECT (SELECT COALESCE(MAX(seq),0) FROM diary_e2ee_changes) sequence,COUNT(*) total FROM diary_e2ee_${kind}`),
    db.prepare(`SELECT * FROM diary_e2ee_${kind} WHERE id>? ORDER BY id LIMIT ?`).bind(after,limit+1),
  ]);
  const rows=result.results.slice(0,limit);
  return {controlGeneration:control.generation,...head.results[0],rows:kind==='records'?rows.map(parseRecord):rows,nextCursor:result.results.length>limit?rows.at(-1).id:null};
}
