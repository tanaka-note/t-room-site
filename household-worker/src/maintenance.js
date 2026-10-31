import {HttpError} from './domain.js';

export const HISTORY_POLICY=Object.freeze({requestDays:90,datasetDays:30,keepRetired:3,maxRequests:1000,maxDatasets:10});
const cutoff=(now,days)=>new Date(now-days*86400000).toISOString().slice(0,10)+' 00:00:00';
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),v=>v.toString(16).padStart(2,'0')).join('');
export async function maintenancePlan(db,now=Date.now()){
  const state=await db.prepare("SELECT revision,active_dataset FROM household_state WHERE id='main'").first();
  if(!state)throw new HttpError(503,'データの準備ができていません。');
  const requestCutoff=cutoff(now,HISTORY_POLICY.requestDays),datasetCutoff=cutoff(now,HISTORY_POLICY.datasetDays),asOf=new Date(now).toISOString().slice(0,19).replace('T',' ');
  const requests=(await db.prepare('SELECT request_id FROM household_requests WHERE created_at<? AND datetime(created_at) IS NOT NULL ORDER BY created_at,request_id LIMIT ?').bind(requestCutoff,HISTORY_POLICY.maxRequests).all()).results;
  const datasets=(await db.prepare(`SELECT d.id,d.created_at,d.activated_at,d.retired_at,d.lease_expires_at,
    (SELECT COUNT(*) FROM household_records r WHERE r.dataset_id=d.id) AS records
    FROM household_datasets d WHERE d.id<>?
    AND datetime(COALESCE(d.retired_at,d.created_at))<=datetime(?)
    AND (d.lease_expires_at IS NULL OR datetime(d.lease_expires_at)<=datetime(?))
    AND d.id NOT IN (SELECT id FROM household_datasets WHERE id<>? AND activated_at IS NOT NULL
      ORDER BY datetime(COALESCE(retired_at,activated_at,created_at)) DESC,id DESC LIMIT ?)
    ORDER BY datetime(COALESCE(d.retired_at,d.created_at)),d.id LIMIT ?`).bind(state.active_dataset,datasetCutoff,asOf,state.active_dataset,HISTORY_POLICY.keepRetired,HISTORY_POLICY.maxDatasets).all()).results;
  const plan={revision:state.revision,activeDataset:state.active_dataset,requestCutoff,datasetCutoff,requests:requests.map(r=>r.request_id),datasets};
  return {...plan,policy:HISTORY_POLICY,fingerprint:await hash(plan),requestCount:requests.length,datasetCount:datasets.length,recordCount:datasets.reduce((n,d)=>n+d.records,0)};
}
export async function maintenanceStatements(db,body,currentRevision,now=Date.now()){
  const plan=await maintenancePlan(db,now);
  if(plan.revision!==currentRevision||body.planFingerprint!==plan.fingerprint)throw new HttpError(409,'整理対象が変わりました。候補を確認し直してください。');
  const statements=[];
  for(let offset=0;offset<plan.requests.length;offset+=90){const ids=plan.requests.slice(offset,offset+90);statements.push(db.prepare(`DELETE FROM household_requests WHERE request_id IN (${ids.map(()=>'?').join(',')}) AND created_at<?`).bind(...ids,plan.requestCutoff));}
  // Recheck live state/lease inside the same batch as revision CAS and receipt.
  for(const dataset of plan.datasets){
    const eligible=`SELECT d.id FROM household_datasets d WHERE d.id=?
      AND d.id<>(SELECT active_dataset FROM household_state WHERE id='main')
      AND datetime(COALESCE(d.retired_at,d.created_at))<=datetime(?)
      AND (d.lease_expires_at IS NULL OR datetime(d.lease_expires_at)<=datetime(?))`;
    const at=new Date(now).toISOString().slice(0,19).replace('T',' ');
    statements.push(db.prepare(`DELETE FROM household_records WHERE dataset_id IN (${eligible})`).bind(dataset.id,plan.datasetCutoff,at));
    statements.push(db.prepare(`DELETE FROM household_datasets WHERE id IN (${eligible}) AND NOT EXISTS(SELECT 1 FROM household_records WHERE dataset_id=household_datasets.id)`).bind(dataset.id,plan.datasetCutoff,at));
  }
  const ids=plan.datasets.map(d=>d.id),at=new Date(now).toISOString().slice(0,19).replace('T',' ');
  // A staging lease can renew without advancing the ledger revision. Refuse the
  // whole cleanup if any reviewed generation is no longer eligible at commit.
  const revisionStatement=ids.length?db.prepare(`UPDATE household_state SET revision=CASE WHEN
    (SELECT COUNT(*) FROM household_datasets WHERE id IN (${ids.map(()=>'?').join(',')})
      AND id<>household_state.active_dataset AND datetime(COALESCE(retired_at,created_at))<=datetime(?)
      AND (lease_expires_at IS NULL OR datetime(lease_expires_at)<=datetime(?)))=? THEN ? ELSE -1 END WHERE id='main'`)
    .bind(...ids,plan.datasetCutoff,at,ids.length,currentRevision+1)
    :db.prepare("UPDATE household_state SET revision=? WHERE id='main'").bind(currentRevision+1);
  return {plan,statements,revisionStatement};
}
