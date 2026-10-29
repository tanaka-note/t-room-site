import { HttpError, uuid, mutateData, records, dataFromRecords, backup, restoreInput, csv } from './domain.js';

export async function loadLedger(env) {
  // Bind records to the exact active generation and revision in one SQLite read.
  const result = await env.DB.prepare(`SELECT s.revision,s.active_dataset,r.kind,r.id,r.payload FROM household_state s
    LEFT JOIN household_records r ON r.dataset_id=s.active_dataset WHERE s.id='main'`).all();
  if (!result.results.length) throw new HttpError(503, 'データの準備ができていません。');
  return { revision: result.results[0].revision, dataset: result.results[0].active_dataset, data: dataFromRecords(result.results.filter(r => r.kind)) };
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
export async function ledgerApi(request, env, path, session, readJson, audit) {
  if (path === '/api/data' && request.method === 'GET') { const ledger = await loadLedger(env); return json({ revision: ledger.revision, data: ledger.data }); }
  if (path === '/api/backup' && request.method === 'GET') return json(backup((await loadLedger(env)).data), 200, { 'Content-Disposition': 'attachment; filename="household-backup.json"' });
  if (path === '/api/export.csv' && request.method === 'GET') return new Response(csv((await loadLedger(env)).data), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="household.csv"', 'Cache-Control': 'no-store' } });
  if (!['/api/mutate','/api/restore'].includes(path) || request.method !== 'POST') throw new HttpError(404, 'ページが見つかりません。');
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
  const restored = path === '/api/restore';
  const next = restored ? restoreInput(body.backup) : mutateData(current.data,body.operation,body.value);
  const nextRows = records(next);
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
    for (let i=0;i<nextRows.length;i+=50) await env.DB.batch(nextRows.slice(i,i+50).map(r => env.DB.prepare('INSERT INTO household_records VALUES (?,?,?,?)').bind(nextDataset,r.kind,r.id,r.payload)));
  } else {
    const old = new Map(records(current.data).map(r => [`${r.kind}:${r.id}`,r]));
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
