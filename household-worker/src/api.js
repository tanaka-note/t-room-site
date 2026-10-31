import { HttpError, uuid, mutateData, dataFromRecords, backup, restoreInput, csv, assetHistory } from './domain.js';
import {maintenancePlan,maintenanceStatements} from './maintenance.js';

export async function loadLedger(env) {
  // Bind records to the exact active generation and revision in one SQLite read.
  const result = await env.DB.prepare(`SELECT s.revision,s.active_dataset,r.kind,r.id,r.payload FROM household_state s
    LEFT JOIN household_records r ON r.dataset_id=s.active_dataset WHERE s.id='main'`).all();
  if (!result.results.length) throw new HttpError(503, 'データの準備ができていません。');
  const rows=result.results.filter(r=>r.kind),data=dataFromRecords(rows);
  const serialized=new Map(rows.map(r=>[`${r.kind}:${r.id}`,r.payload]));
  return { revision: result.results[0].revision, dataset: result.results[0].active_dataset, data, serialized };
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
export async function ledgerApi(request, env, path, session, readJson, audit) {
  if (path === '/api/data' && request.method === 'GET') { const ledger = await loadLedger(env); return json({ revision: ledger.revision, data: ledger.data, assetHistory: assetHistory(ledger.data) }); }
  if (path === '/api/backup' && request.method === 'GET') return json(backup((await loadLedger(env)).data), 200, { 'Content-Disposition': 'attachment; filename="household-backup.json"' });
  if (path === '/api/export.csv' && request.method === 'GET') return new Response(csv((await loadLedger(env)).data), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="household.csv"', 'Cache-Control': 'no-store' } });
  if(path==='/api/maintenance/preview'&&request.method==='GET'){
    if(session.role!=='owner')throw new HttpError(403,'このアカウントは閲覧専用です。');
    const plan=await maintenancePlan(env.DB);return json({revision:plan.revision,policy:plan.policy,planFingerprint:plan.fingerprint,requestCount:plan.requestCount,datasetCount:plan.datasetCount,recordCount:plan.recordCount});
  }
  if (!['/api/mutate','/api/restore','/api/maintenance'].includes(path) || request.method !== 'POST') throw new HttpError(404, 'ページが見つかりません。');
  if (session.role !== 'owner') throw new HttpError(403, 'このアカウントは閲覧専用です。');
  const body = await readJson(request), requestId = uuid(body.requestId);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new HttpError(400, 'データのバージョンを確認してください。');
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ path, body })))), n => n.toString(16).padStart(2,'0')).join('');
  async function replay() {
    const row = await env.DB.prepare('SELECT fingerprint,response_json FROM household_requests WHERE request_id=?').bind(requestId).first();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, '同じ操作IDで異なる内容は送信できません。');
    return json(JSON.parse(row.response_json));
  }
  const previous = await replay(); if (previous) return previous;
  const current = await loadLedger(env);
  if (current.revision !== body.expectedRevision) throw new HttpError(409, '別の画面で変更されています。最新の状態を読み込んでからやり直してください。','conflict');
  if(path==='/api/maintenance'){
    if(body.confirmCleanup!==true)throw new HttpError(400,'整理対象を確認してください。');
    const cleanup=await maintenanceStatements(env.DB,body,current.revision);
    const value={ok:true,revision:current.revision+1,deletedRequests:cleanup.plan.requestCount,deletedDatasets:cleanup.plan.datasetCount,deletedRecords:cleanup.plan.recordCount};
    try{await env.DB.batch([
      env.DB.prepare('INSERT INTO household_requests(request_id,fingerprint,response_json) VALUES (?,?,?)').bind(requestId,fingerprint,JSON.stringify(value)),
      cleanup.revisionStatement,...cleanup.statements]);}
    catch(error){const duplicate=await replay();if(duplicate)return duplicate;if(/household_revision_conflict/.test(String(error?.message)))throw new HttpError(409,'整理対象が変わりました。候補を確認し直してください。');throw error;}
    await audit(env,request,session,'data_update');return json(value);
  }
  const restored = path === '/api/restore';
  const next = restored ? restoreInput(body.backup) : mutateData(current.data,body.operation,body.value);
  const oldRecords=new Map(Object.entries(current.data).flatMap(([kind,rows])=>rows.map(row=>[`${kind}:${row.id}`,row])));
  const nextRows = Object.entries(next).flatMap(([kind,rows])=>rows.map(row=>({kind,id:row.id,payload:!restored&&oldRecords.get(`${kind}:${row.id}`)===row?current.serialized.get(`${kind}:${row.id}`):JSON.stringify(row)})));
  if (nextRows.reduce((size,r)=>size+new TextEncoder().encode(r.payload).length,0)>10*1024*1024) throw new HttpError(413, '保存できるデータ量の上限に達しました。');
  const nextDataset = restored ? crypto.randomUUID() : current.dataset;
  const value = { ok: true, revision: current.revision + 1 };
  const statements = [
    env.DB.prepare('INSERT INTO household_requests(request_id,fingerprint,response_json) VALUES (?,?,?)').bind(requestId,fingerprint,JSON.stringify(value)),
    env.DB.prepare("UPDATE household_state SET revision=?,active_dataset=? WHERE id='main'").bind(current.revision+1,nextDataset)
  ];
  if (restored) {
    // Staging rows cannot be read by API clients until the final CAS succeeds.
    // Each attempt has a separate generation, including simultaneous retries.
    await env.DB.prepare("INSERT INTO household_datasets(id,lease_expires_at) VALUES(?,datetime('now','+1 hour'))").bind(nextDataset).run();
    for (let i=0;i<nextRows.length;i+=50) await env.DB.batch([
      env.DB.prepare("UPDATE household_datasets SET lease_expires_at=datetime('now','+1 hour') WHERE id=?").bind(nextDataset),
      ...nextRows.slice(i,i+50).map(r => env.DB.prepare('INSERT INTO household_records VALUES (?,?,?,?)').bind(nextDataset,r.kind,r.id,r.payload))]);
    statements.push(env.DB.prepare('UPDATE household_datasets SET retired_at=CURRENT_TIMESTAMP WHERE id=?').bind(current.dataset),
      env.DB.prepare('UPDATE household_datasets SET activated_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=?').bind(nextDataset));
  } else {
    const old = new Map([...current.serialized].map(([key,payload])=>{const split=key.indexOf(':');return [key,{kind:key.slice(0,split),id:key.slice(split+1),payload}];}));
    for (const row of nextRows) { const key=`${row.kind}:${row.id}`, before=old.get(key); if (!before || before.payload!==row.payload) statements.push(env.DB.prepare('INSERT OR REPLACE INTO household_records VALUES (?,?,?,?)').bind(current.dataset,row.kind,row.id,row.payload)); old.delete(key); }
    for (const row of old.values()) statements.push(env.DB.prepare('DELETE FROM household_records WHERE dataset_id=? AND kind=? AND id=?').bind(current.dataset,row.kind,row.id));
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    const duplicate = await replay(); if (duplicate) return duplicate;
    if (/household_revision_conflict/.test(String(error?.message))) throw new HttpError(409, '別の画面で変更されています。最新の状態を読み込んでください。','conflict');
    throw error;
  }
  await audit(env,request,session,restored ? 'backup_restore' : 'data_update');
  return json(value);
}
