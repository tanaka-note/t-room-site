import { WorkerEntrypoint } from 'cloudflare:workers';
import { requireSessionSecret, isValidSessionSecret } from '../../assets/session-secret.mjs';
import { lineBrowserResponse } from '../../assets/line-browser-worker.mjs';
import { LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from '../../assets/line-browser-csp.mjs';
import { serviceRollingSession, renewServiceSession, ROLLING_SESSION_VERSION } from '../../assets/passkey-rolling.mjs';
import { sessionCookieValue, sessionPolicyForAuthMethod } from '../../assets/session-policy.mjs';
import { recordSecurityAudit } from '../../assets/security-audit-worker.js';
import { HttpError, text, uuid, paymentInput, paymentView, currentJstMonth } from './domain.js';
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
    if (!['/', '/index.html', '/payments.css', '/payments.js', '/dialog-navigation.js', '/troom-date-picker.js', '/troom-date-picker.css', '/date-wheel.js', '/date-wheel.css'].includes(path)) throw new HttpError(404, 'ページが見つかりません。');
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
    const result = await env.DB.prepare('SELECT * FROM payments_entries WHERE account_id = ? AND deleted_at IS NULL ORDER BY paid_on DESC, id').bind('owner').all();
    const currentMonth = currentJstMonth();
    return json({ currentMonth, entries: result.results.map(row => paymentView(row, currentMonth)) });
  }
  const match = /^\/api\/entries\/([a-f0-9-]+)$/.exec(path);
  if ((path === '/api/entries' && request.method === 'POST') || (match && ['PUT', 'DELETE'].includes(request.method))) {
    const body = await readJson(request), requestId = uuid(body.requestId), now = new Date().toISOString();
    const input = request.method === 'DELETE' ? null : paymentInput(body);
    const id = match ? uuid(match[1]) : requestId;
    if (match && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) throw new HttpError(400, '明細のバージョンを確認してください。');
    return idempotent(env, requestId, { path, method: request.method, input, expectedVersion: body.expectedVersion ?? null }, async () => {
      if (match) {
        const existing = await env.DB.prepare('SELECT version, deleted_at FROM payments_entries WHERE id = ? AND account_id = ?').bind(id, 'owner').first();
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
      return { value: { id }, statements: [statement] };
    });
  }
  throw new HttpError(404, 'ページが見つかりません。');
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
  const { value, statements } = await prepare();
  try {
    await env.DB.batch([env.DB.prepare('INSERT INTO payments_requests VALUES (?, ?, ?, ?)').bind(requestId, fingerprint, JSON.stringify(value), new Date().toISOString()), ...statements]);
  } catch (error) {
    const duplicate = await replay(); if (duplicate) return duplicate;
    if (/payments_version_conflict/.test(String(error?.message))) throw new HttpError(409, '別の画面で変更されています。一覧を更新してから編集し直してください。');
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
