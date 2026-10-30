import { WorkerEntrypoint } from 'cloudflare:workers';
import { requireSessionSecret, isValidSessionSecret } from '../../assets/session-secret.mjs';
import { lineBrowserResponse } from '../../assets/line-browser-worker.mjs';
import { LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from '../../assets/line-browser-csp.mjs';
import { serviceRollingSession, renewServiceSession, ROLLING_SESSION_VERSION } from '../../assets/passkey-rolling.mjs';
import { sessionCookieValue, sessionPolicyForAuthMethod } from '../../assets/session-policy.mjs';
import { recordSecurityAudit } from '../../assets/security-audit-worker.js';
import { HttpError, text } from './domain.js';
import { ledgerApi } from './api.js';
const BASE = '/household', SERVICE = 'household', COOKIE = 'troom_household_session';
const encoder = new TextEncoder();
const authorized = new WeakMap();
const sessionVersion = (env, account) => `${env.SESSION_VERSION || '1'}:${account.session_version}`;
const enabled = env => String(env.PASSKEY_ENABLED || 'false') === 'true';
const accountRecord = (env,id) => ['owner','viewer'].includes(id) ? env.DB.prepare('SELECT * FROM household_accounts WHERE id=? AND is_active=1').bind(id).first() : null;

export default class HouseholdWorker extends WorkerEntrypoint {
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
    const account = await accountRecord(this.env,input?.serviceAccountId);
    return account ? { sessionVersion: sessionVersion(this.env, account), passkeyEnabled: enabled(this.env) } : null;
  }
  async listLinkTargets() {
    const result = await this.env.DB.prepare('SELECT * FROM household_accounts WHERE is_active=1 ORDER BY id').all();
    return { service: SERVICE, displayName: '家計簿', targets: result.results.map(linkTarget) };
  }
  async describeAccount(input) {
    const account = input?.rootFolderId == null ? await accountRecord(this.env,input?.accountId) : null;
    return account ? { valid: true, ...linkTarget(account) } : { valid: false };
  }
}
function linkTarget(account) {
  return { accountId: account.id, displayLabel: account.display_name, role: account.role, roleLabel: account.role === 'owner' ? 'オーナー' : '閲覧専用', privileged: account.role === 'owner', exclusive: account.role === 'owner', shared: account.role === 'viewer', rootFolderId: null };
}

export async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new HttpError(403, 'HTTPSでアクセスしてください。');
  if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 308);
  if (!url.pathname.startsWith(`${BASE}/`)) throw new HttpError(404, 'ページが見つかりません。');
  const path = url.pathname.slice(BASE.length);
  if (!path.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'この操作は利用できません。');
    if (!['/', '/index.html', '/household.css', '/household.js', '/asset-chart.js', '/dialog-navigation.js', '/troom-date-picker.js', '/troom-date-picker.css', '/date-wheel.js', '/date-wheel.css'].includes(path)) throw new HttpError(404, 'ページが見つかりません。');
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
    return json({ authenticated: true, displayName: (await accountRecord(env,session.serviceAccountId)).display_name, role: session.role });
  }
  if (path === '/api/logout' && request.method === 'POST') {
    if (!(await serviceRollingSession(env, SERVICE, session, 'end')).valid) throw new HttpError(503, 'ログアウトを完了できませんでした。');
    await audit(env, request, session, 'logout');
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=${BASE}; Max-Age=0; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}` });
  }
  return ledgerApi(request,env,path,session,readJson,audit);
}

async function handoff(request, env, url) {
  if (!enabled(env) || !env.SECURITY) throw new HttpError(503, '認証の準備ができていません。');
  const body = await readJson(request);
  const value = await env.SECURITY.redeemHandoff(text(body.handoffToken, 200, '認証情報'), SERVICE);
  const account = value ? await accountRecord(env,value.serviceAccountId) : null;
  if (!value || !account || (account.role === 'owner' && value.identityId !== 'primary-admin') || value.cloudRootFolderId != null) throw new HttpError(401, '利用できるパスキーを確認できませんでした。');
  const session = { service: SERVICE, identityId: value.identityId, credentialId: value.credentialId, serviceLinkId: value.serviceLinkId,
    serviceAccountId: account.id, role: account.role, passkeySessionEpoch: value.sessionEpoch, authMethod: 'passkey', rollingSessionVersion: ROLLING_SESSION_VERSION,
    sessionId: crypto.randomUUID(), startedAt: new Date().toISOString(), sessionVersion: sessionVersion(env, account), expiresAt: Math.floor(Date.now() / 1000) + sessionPolicyForAuthMethod(env, 'passkey').ttlSeconds };
  if (!(await serviceRollingSession(env, SERVICE, session, 'register')).valid) throw new HttpError(503, 'セッションを開始できませんでした。');
  await audit(env, request, session, 'passkey_login_success');
  return json({ authenticated: true, displayName: account.display_name, role: account.role }, 200, { 'Set-Cookie': cookie(await signSession(session, env), url, env) });
}
async function requireSession(request, env) {
  const raw = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  let session = null;
  try {
    const [payload, signature, extra] = (raw || '').split('.');
    if (payload && signature && !extra && await verifySignature(payload, signature, env.SESSION_SECRET)) session = JSON.parse(new TextDecoder().decode(fromBase64(payload)));
  } catch { /* Invalid cookies never authorize. */ }
  const account = session ? await accountRecord(env,session.serviceAccountId) : null;
  if (!account || !enabled(env) || session.service !== SERVICE || session.authMethod !== 'passkey' || session.role !== account.role
    || (account.role === 'owner' && session.identityId !== 'primary-admin') || session.sessionVersion !== sessionVersion(env, account)
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
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new HttpError(413, '入力内容が大きすぎます。'); } chunks.push(value); }
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
