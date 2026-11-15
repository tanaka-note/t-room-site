import { HttpError, amount, reportView, storedRecord, validateRecord } from './domain.js';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
async function state(env) {
  const row = await env.DB.prepare("SELECT revision,metadata FROM portfolio_state WHERE id='main'").first();
  if (!row) throw new HttpError(503, '資産データの準備中です。');
  return { revision: row.revision, metadata: JSON.parse(row.metadata) };
}
export async function portfolioApi(request, env, path, session, readJson, audit) {
  if (request.method === 'GET' && path === '/api/data') {
    // One SQL snapshot keeps the revision, totals and holdings consistent even
    // while a second tab commits a save.
    const current = await env.DB.prepare(`SELECT revision,metadata,
      (SELECT json_group_array(json_object('period',period,'time',time,'raw_market_value',raw_market_value,'assets',assets))
       FROM (SELECT period,time,raw_market_value,assets FROM portfolio_records ORDER BY period)) AS records
      FROM portfolio_state WHERE id='main'`).first();
    if (!current) throw new HttpError(503, '資産データの準備中です。');
    current.metadata = JSON.parse(current.metadata);
    const records = JSON.parse(current.records), latest = records.at(-1);
    if (!latest) throw new HttpError(503, '資産データの準備中です。');
    const history = records.map(r => ({ period: r.period, basePrincipal: current.metadata.basePrincipal, rawMarketValue: r.raw_market_value }));
    return json({ revision: current.revision, metadata: current.metadata, history, record: storedRecord(latest), report: reportView(current.metadata, history, storedRecord(latest)) });
  }
  if (request.method === 'GET' && path === '/api/record') {
    const period = new URL(request.url).searchParams.get('period');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period || '')) throw new HttpError(400, '日付を確認してください。');
    const record = await env.DB.prepare('SELECT * FROM portfolio_records WHERE period=?').bind(period).first();
    if (!record) throw new HttpError(404, 'この日付の記録はありません。', 'missing_record');
    return json({ record: storedRecord(record) });
  }
  if (request.method === 'GET' && path === '/api/backup') {
    const current = await state(env), records = (await env.DB.prepare('SELECT * FROM portfolio_records ORDER BY period').all()).results;
    const changes = (await env.DB.prepare('SELECT * FROM portfolio_changes ORDER BY revision').all()).results;
    return json({ format: 'troom-portfolio', version: 1, ...current, records, changes });
  }
  if (path === '/api/save' && request.method === 'POST') {
    if (session.role !== 'owner') throw new HttpError(403, '閲覧者は編集できません。');
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 || !/^[a-f0-9-]{36}$/i.test(body.requestId || '')) throw new HttpError(400, '保存情報を確認してください。');
    const current = await state(env), record = validateRecord(body.record, current.metadata);
    const hasPrincipal = Object.hasOwn(body, 'basePrincipal');
    const basePrincipal = hasPrincipal ? amount(body.basePrincipal) : current.metadata.basePrincipal;
    if (basePrincipal === 0) throw new HttpError(400, '元本は1円以上の整数円で入力してください。');
    const principalChange = hasPrincipal ? { basePrincipal } : {};
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ expectedRevision: body.expectedRevision, record, ...principalChange })))), x => x.toString(16).padStart(2, '0')).join('');
    const previousRequest = await env.DB.prepare('SELECT revision,fingerprint FROM portfolio_changes WHERE request_id=?').bind(body.requestId).first();
    if (previousRequest) {
      if (previousRequest.fingerprint !== fingerprint) throw new HttpError(409, '同じ保存IDで異なる内容は保存できません。', 'conflict');
      return json({ ok: true, revision: previousRequest.revision, period: record.period });
    }
    if (current.revision !== body.expectedRevision) throw new HttpError(409, '別の画面で更新されています。再読み込みして確認してください。', 'conflict');
    const prior = await env.DB.prepare('SELECT * FROM portfolio_records WHERE period=?').bind(record.period).first();
    // Imported historical summaries have no invented per-stock breakdown.
    if (record.assets === null && (!prior || prior.assets !== null)) throw new HttpError(400, 'この日付は銘柄別に入力してください。');
    const revision = current.revision + 1, now = new Date().toISOString();
    const previousRecord = prior ? storedRecord(prior) : null;
    const previousChange = hasPrincipal ? { ...previousRecord, basePrincipal: current.metadata.basePrincipal } : previousRecord;
    const savedChange = { ...record, ...principalChange };
    try {
      await env.DB.batch([
        // CAS must fail inside the transaction if another save wins after reading.
        env.DB.prepare("UPDATE portfolio_state SET metadata=?,revision=CASE WHEN revision=? THEN revision+1 ELSE -1 END WHERE id='main'").bind(JSON.stringify({ ...current.metadata, basePrincipal }), current.revision),
        env.DB.prepare('INSERT INTO portfolio_records(period,time,raw_market_value,assets,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(period) DO UPDATE SET time=excluded.time,raw_market_value=excluded.raw_market_value,assets=excluded.assets,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
          .bind(record.period, record.time, record.rawMarketValue, record.assets === null ? null : JSON.stringify(record.assets), now, session.serviceAccountId),
        env.DB.prepare('INSERT INTO portfolio_changes(revision,request_id,fingerprint,period,previous_record,saved_record,updated_at,account_id) VALUES(?,?,?,?,?,?,?,?)')
          .bind(revision, body.requestId, fingerprint, record.period, previousChange ? JSON.stringify(previousChange) : null, JSON.stringify(savedChange), now, session.serviceAccountId)
      ]);
    } catch {
      const saved = await env.DB.prepare('SELECT revision,fingerprint FROM portfolio_changes WHERE request_id=?').bind(body.requestId).first();
      if (saved?.fingerprint === fingerprint) return json({ ok: true, revision: saved.revision, period: record.period });
      throw new HttpError(409, '保存が競合しました。再読み込みして確認してください。', 'conflict');
    }
    await audit(env, request, session, 'portfolio_record_saved');
    return json({ ok: true, revision, period: record.period });
  }
  throw new HttpError(404, 'ページが見つかりません。');
}
