import { WorkerEntrypoint } from 'cloudflare:workers';
import { requireSessionSecret, isValidSessionSecret } from '../../assets/session-secret.mjs';
import { lineBrowserResponse } from '../../assets/line-browser-worker.mjs';
import { LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from '../../assets/line-browser-csp.mjs';
import { serviceRollingSession, renewServiceSession, ROLLING_SESSION_VERSION } from '../../assets/passkey-rolling.mjs';
import { sessionCookieValue, sessionPolicyForAuthMethod } from '../../assets/session-policy.mjs';
import { recordSecurityAudit } from '../../assets/security-audit-worker.js';
import { HttpError, text, uuid, month, allocation, paymentInput, paymentView, monthlyView, dashboard, currentJstMonth } from './domain.js';
const BASE = '/payments', SERVICE = 'payments', COOKIE = 'troom_payments_session';
const encoder = new TextEncoder();
const authorized = new WeakMap();
const sessionVersion = (env, account) => `${env.SESSION_VERSION || '1'}:${account.session_version}`;
const enabled = env => String(env.PASSKEY_ENABLED || 'false') === 'true';
const accountRecord = env => env.DB.prepare("SELECT * FROM payments_accounts WHERE id = 'owner' AND is_active = 1").first();

export default class PaymentsWorker extends WorkerEntrypoint {
  async fetch(request) {
    const blocked = lineBrowserResponse(request);
    if (blocked) return blocked;
    try {
      const response = await handleRequest(request, this.env, this.ctx);
      const session = authorized.get(request);
      return secure(await renewServiceSession(request, response, this.env, SERVICE, new URL(request.url).pathname.slice(BASE.length), session,
        async expiresAt => cookie(await signSession({ ...session, expiresAt }, this.env), new URL(request.url), this.env)));
    } catch (error) {
      // Never log exception messages: database or input errors can contain personal data.
      return secure(json({ error: error instanceof HttpError ? error.message : '処理を完了できませんでした。時間を置いて再試行してください。', code: error instanceof HttpError ? error.code : 'unavailable' }, error instanceof HttpError ? error.status : 503));
    }
  }
}

export class SecurityIntegration extends WorkerEntrypoint {
  async getSessionRuntimeState(input) {
    const account = input?.serviceAccountId === 'owner' ? await accountRecord(this.env) : null;
    return account ? { sessionVersion: sessionVersion(this.env, account), passkeyEnabled: enabled(this.env) } : null;
  }
  async listLinkTargets() {
    const account = await accountRecord(this.env);
    return { service: SERVICE, displayName: '支払明細', targets: account ? [linkTarget(account)] : [] };
  }
  async describeAccount(input) {
    const account = input?.accountId === 'owner' && input?.rootFolderId == null ? await accountRecord(this.env) : null;
    return account ? { valid: true, ...linkTarget(account) } : { valid: false };
  }
}
function linkTarget(account) {
  return { accountId: account.id, displayLabel: account.display_name, role: 'owner', roleLabel: 'オーナー', privileged: true, exclusive: true, shared: false, rootFolderId: null };
}

export async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new HttpError(403, 'HTTPSでアクセスしてください。');
  if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 308);
  if (!url.pathname.startsWith(`${BASE}/`)) throw new HttpError(404, 'ページが見つかりません。');
  const path = url.pathname.slice(BASE.length);
  if (!path.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'この操作は利用できません。');
    if (!['/', '/index.html', '/payments.css', '/payments.js', '/dialog-navigation.js'].includes(path)) throw new HttpError(404, 'ページが見つかりません。');
    const response = await env.ASSETS.fetch(new Request(new URL(path === '/index.html' ? '/' : path, url.origin), request));
    const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
  requireSessionSecret(env.SESSION_SECRET, HttpError);
  if (request.method !== 'GET') mutationGuard(request, url);
  if (path === '/api/passkey/handoff' && request.method === 'POST') return handoff(request, env, url);
  const session = await requireSession(request, env);
  authorized.set(request, session);
  if (path === '/api/session' && request.method === 'GET') {
    await audit(env, request, session, 'session_resume');
    return json({ authenticated: true, displayName: (await accountRecord(env)).display_name });
  }
  if (path === '/api/logout' && request.method === 'POST') {
    if (!(await serviceRollingSession(env, SERVICE, session, 'end')).valid) throw new HttpError(503, 'ログアウトを完了できませんでした。');
    await audit(env, request, session, 'logout');
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=${BASE}; Max-Age=0; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}` });
  }
  if (path === '/api/entries' && request.method === 'GET') {
    const currentMonth = currentJstMonth();
    const result = await env.DB.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM payments_monthly_marks m WHERE m.entry_id=e.id AND m.completed_at IS NOT NULL) completed_count,
      (SELECT COUNT(*) FROM payments_monthly_marks m WHERE m.entry_id=e.id AND m.completed_at IS NOT NULL AND m.target_month < ?) past_completed_count,
      (SELECT COALESCE(SUM(m.amount),0) FROM payments_monthly_marks m WHERE m.entry_id=e.id AND m.completed_at IS NOT NULL AND m.target_month < ?) past_completed_amount,
      (SELECT completed_at FROM payments_monthly_marks m WHERE m.entry_id=e.id AND m.target_month=?) current_completed_at
      FROM payments_entries e WHERE e.account_id=? AND e.deleted_at IS NULL ORDER BY e.paid_on DESC,e.id`).bind(currentMonth,currentMonth,currentMonth,'owner').all();
    const entries = result.results.map(row => paymentView({ ...row, current_completed: !!row.current_completed_at }, currentMonth));
    return json({ currentMonth, entries, dashboard: dashboard(entries) });
  }
  const detail = /^\/api\/entries\/([a-f0-9-]+)\/months$/.exec(path);
  if (detail && request.method === 'GET') {
    const id = uuid(detail[1]);
    const entry = await env.DB.prepare('SELECT * FROM payments_entries WHERE id=? AND account_id=? AND deleted_at IS NULL').bind(id,'owner').first();
    if (!entry) throw new HttpError(404, '明細が見つかりません。');
    const marks = await env.DB.prepare('SELECT * FROM payments_monthly_marks WHERE entry_id=? ORDER BY target_month').bind(id).all();
    const history = await env.DB.prepare('SELECT target_month,action,occurred_at,identity_id,entry_version,amount,previous_amount,start_month,previous_start_month,months,previous_months FROM payments_operation_audit WHERE entry_id=? ORDER BY occurred_at DESC,request_id DESC LIMIT 100').bind(id).all();
    return json({ id, version: entry.version, currentMonth: currentJstMonth(), months: monthlyView(entry,marks.results,currentJstMonth()), history: history.results });
  }
  const mark = /^\/api\/entries\/([a-f0-9-]+)\/months\/(\d{4}-\d{2})$/.exec(path);
  if (mark && request.method === 'PUT') {
    const id=uuid(mark[1]), targetMonth=mark[2], target=month(targetMonth), body=await readJson(request), requestId=uuid(body.requestId);
    if (typeof body.completed !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw new HttpError(400,'計上操作を確認してください。');
    return idempotent(env,requestId,{path,method:request.method,completed:body.completed,expectedVersion:body.expectedVersion},async () => {
      const entry=await env.DB.prepare('SELECT * FROM payments_entries WHERE id=? AND account_id=?').bind(id,'owner').first();
      if (!entry || entry.deleted_at) throw new HttpError(404,'明細が見つかりません。');
      if (entry.version !== body.expectedVersion) throw new HttpError(409,'別の画面で変更されています。最新の状態を確認して操作し直してください。');
      const offset=target-month(entry.start_month);
      if (offset < 0 || offset >= entry.months || (body.completed && targetMonth > currentJstMonth())) throw new HttpError(400,'対象期間内の今月以前の月を選んでください。');
      const previous=await env.DB.prepare('SELECT completed_at FROM payments_monthly_marks WHERE entry_id=? AND target_month=?').bind(id,targetMonth).first();
      if (!!previous?.completed_at === body.completed) return { value:{id}, statements:[] };
      const now=new Date().toISOString(), amount=allocation(entry.amount,entry.months,offset);
      return {value:{id},statements:[
        env.DB.prepare('UPDATE payments_entries SET version=?,updated_at=? WHERE id=? AND account_id=?').bind(body.expectedVersion+1,now,id,'owner'),
        env.DB.prepare(`INSERT INTO payments_monthly_marks(entry_id,target_month,amount,completed_at) VALUES (?,?,?,?)
          ON CONFLICT(entry_id,target_month) DO UPDATE SET completed_at=excluded.completed_at`).bind(id,targetMonth,amount,body.completed ? now : null),
        operationAudit(env,requestId,id,targetMonth,body.completed ? 'month_complete' : 'month_undo',now,session,body.expectedVersion+1,{amount})
      ]};
    });
  }
  const match = /^\/api\/entries\/([a-f0-9-]+)$/.exec(path);
  if ((path === '/api/entries' && request.method === 'POST') || (match && ['PUT', 'DELETE'].includes(request.method))) {
    const body = await readJson(request), requestId = uuid(body.requestId), now = new Date().toISOString();
    const input = request.method === 'DELETE' ? null : paymentInput(body);
    const id = match ? uuid(match[1]) : requestId;
    if (match && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) throw new HttpError(400, '明細のバージョンを確認してください。');
    return idempotent(env, requestId, { path, method: request.method, input, expectedVersion: body.expectedVersion ?? null }, async () => {
      let existing = null;
      if (match) {
        existing = await env.DB.prepare('SELECT * FROM payments_entries WHERE id = ? AND account_id = ?').bind(id, 'owner').first();
        if (!existing || existing.deleted_at) throw new HttpError(404, '明細が見つかりません。一覧を更新してください。');
        if (existing.version !== body.expectedVersion) throw new HttpError(409, '別の画面で変更されています。一覧を更新してから編集し直してください。');
      }
      let statement;
      if (request.method === 'DELETE') statement = env.DB.prepare('UPDATE payments_entries SET deleted_at = ?, updated_at = ?, version = ? WHERE id = ? AND account_id = ?').bind(now, now, body.expectedVersion + 1, id, 'owner');
      else {
        const values = [input.paidOn, input.payee, input.description, input.amount, input.startMonth, input.months, input.notes];
        statement = match
          ? env.DB.prepare('UPDATE payments_entries SET paid_on = ?, payee = ?, description = ?, amount = ?, start_month = ?, months = ?, notes = ?, updated_at = ?, version = ? WHERE id = ? AND account_id = ?').bind(...values, now, body.expectedVersion + 1, id, 'owner')
          : env.DB.prepare('INSERT INTO payments_entries (paid_on, payee, description, amount, start_month, months, notes, id, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...values, id, 'owner', now, now);
      }
      const changed = existing && input && (existing.amount !== input.amount || existing.start_month !== input.startMonth || existing.months !== input.months);
      const action = request.method === 'DELETE' ? 'entry_delete' : !existing ? 'entry_create' : changed ? 'allocation_change' : 'entry_edit';
      return { value: { id }, statements: [statement, operationAudit(env,requestId,id,null,action,now,session,match ? body.expectedVersion+1 : 1,
        {amount:input?.amount ?? existing?.amount,previous_amount:existing?.amount,start_month:input?.startMonth ?? existing?.start_month,previous_start_month:existing?.start_month,months:input?.months ?? existing?.months,previous_months:existing?.months})] };
    });
  }
  throw new HttpError(404, 'ページが見つかりません。');
}

function operationAudit(env,requestId,id,targetMonth,action,now,session,version,data={}) {
  return env.DB.prepare(`INSERT INTO payments_operation_audit
    (request_id,entry_id,target_month,action,occurred_at,identity_id,account_id,entry_version,amount,previous_amount,start_month,previous_start_month,months,previous_months)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId,id,targetMonth,action,now,session.identityId,session.serviceAccountId,version,
      data.amount ?? null,data.previous_amount ?? null,data.start_month ?? null,data.previous_start_month ?? null,data.months ?? null,data.previous_months ?? null);
}

async function idempotent(env, requestId, input, prepare) {
  const fingerprint = toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(input)))));
  async function replay() {
    const row = await env.DB.prepare('SELECT fingerprint, response_json FROM payments_requests WHERE request_id = ?').bind(requestId).first();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, '同じ操作IDで異なる内容は送信できません。');
    return json(JSON.parse(row.response_json));
  }
  const previous = await replay(); if (previous) return previous;
  let prepared;
  try { prepared = await prepare(); }
  catch (error) {
    // Another copy can commit between the replay read and optimistic checks.
    const duplicate = await replay(); if (duplicate) return duplicate;
    throw error;
  }
  const { value, statements } = prepared;
  try {
    await env.DB.batch([env.DB.prepare('INSERT INTO payments_requests VALUES (?, ?, ?, ?)').bind(requestId, fingerprint, JSON.stringify(value), new Date().toISOString()), ...statements]);
  } catch (error) {
    const duplicate = await replay(); if (duplicate) return duplicate;
    if (/payments_version_conflict/.test(String(error?.message))) throw new HttpError(409, '別の画面で変更されています。一覧を更新してから編集し直してください。');
    if (/payments_completed_locked/.test(String(error?.message))) throw new HttpError(409, '計上済みの月があります。金額・対象期間の変更や削除は、月別履歴で全ての計上を取り消してから行ってください。');
    if (/payments_invalid_month/.test(String(error?.message))) throw new HttpError(409, '対象月の状態が変わりました。一覧を更新してください。');
    throw error;
  }
  return json(value);
}

async function handoff(request, env, url) {
  if (!enabled(env) || !env.SECURITY) throw new HttpError(503, '認証の準備ができていません。');
  const account = await accountRecord(env);
  if (!account) throw new HttpError(503, 'アカウントの準備ができていません。');
  const body = await readJson(request);
  const value = await env.SECURITY.redeemHandoff(text(body.handoffToken, 200, '認証情報'), SERVICE);
  if (!value || value.identityId !== 'primary-admin' || value.serviceAccountId !== account.id || value.cloudRootFolderId != null) throw new HttpError(401, '利用できるパスキーを確認できませんでした。');
  const session = { service: SERVICE, identityId: value.identityId, credentialId: value.credentialId, serviceLinkId: value.serviceLinkId,
    serviceAccountId: account.id, role: 'owner', passkeySessionEpoch: value.sessionEpoch, authMethod: 'passkey', rollingSessionVersion: ROLLING_SESSION_VERSION,
    sessionId: crypto.randomUUID(), startedAt: new Date().toISOString(), sessionVersion: sessionVersion(env, account), expiresAt: Math.floor(Date.now() / 1000) + sessionPolicyForAuthMethod(env, 'passkey').ttlSeconds };
  if (!(await serviceRollingSession(env, SERVICE, session, 'register')).valid) throw new HttpError(503, 'セッションを開始できませんでした。');
  await audit(env, request, session, 'passkey_login_success');
  return json({ authenticated: true, displayName: account.display_name }, 200, { 'Set-Cookie': cookie(await signSession(session, env), url, env) });
}
async function requireSession(request, env) {
  const raw = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  let session = null;
  try {
    const [payload, signature, extra] = (raw || '').split('.');
    if (payload && signature && !extra && await verifySignature(payload, signature, env.SESSION_SECRET)) session = JSON.parse(new TextDecoder().decode(fromBase64(payload)));
  } catch { /* Invalid cookies never authorize. */ }
  const account = session ? await accountRecord(env) : null;
  if (!account || !enabled(env) || session.service !== SERVICE || session.authMethod !== 'passkey' || session.role !== 'owner'
    || session.identityId !== 'primary-admin' || session.serviceAccountId !== 'owner' || session.sessionVersion !== sessionVersion(env, account)
    || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Math.floor(Date.now() / 1000)
    || session.rollingSessionVersion !== ROLLING_SESSION_VERSION || !(await serviceRollingSession(env, SERVICE, session, 'read')).valid) throw new HttpError(401, 'パスキーでログインしてください。');
  return session;
}
async function audit(env, request, session, eventType) {
  await recordSecurityAudit(env, request, { service: SERVICE, eventType, outcome: 'success', identityId: session.identityId,
    serviceLinkId: session.serviceLinkId, serviceAccountId: session.serviceAccountId, role: session.role, authMethod: 'passkey',
    sessionId: session.sessionId, credentialId: session.credentialId, expiresAt: session.expiresAt, startedAt: session.startedAt,
    sessionVersion: session.sessionVersion, passkeySessionEpoch: session.passkeySessionEpoch });
}
function cookie(token, url, env) { return sessionCookieValue(COOKIE, token, BASE, sessionPolicyForAuthMethod(env, 'passkey'), url.protocol === 'https:'); }
async function signingKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function signSession(payload, env) {
  if (!isValidSessionSecret(env.SESSION_SECRET)) throw new HttpError(503, '認証設定を確認してください。');
  const encoded = toBase64(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env.SESSION_SECRET), encoder.encode(encoded))))}`;
}
async function verifySignature(payload, signature, secret) { return crypto.subtle.verify('HMAC', await signingKey(secret), fromBase64(signature), encoder.encode(payload)); }
function toBase64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromBase64(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('invalid');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
}
function mutationGuard(request, url) {
  if (request.headers.get('Origin') !== url.origin || !/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(403, '操作元を確認できません。');
}
async function readJson(request) {
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, '入力内容を確認してください。');
  const chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw new HttpError(413, '入力内容が大きすぎます。'); } chunks.push(value); }
  try { const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder().decode(all)); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value;
  } catch { throw new HttpError(400, '入力内容を確認してください。'); }
}
function json(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function secure(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff'); headers.set('X-Frame-Options', 'DENY'); headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  // Shared generated LINE guard uses an exact hash added by the common helper.
  headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self' ${LINE_BROWSER_SCRIPT_CSP}; style-src 'self' ${LINE_BROWSER_STYLE_CSP}; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  return new Response(response.body, { status: response.status, headers });
}
