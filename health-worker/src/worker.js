import { requireSessionSecret } from '../../assets/session-secret.mjs';
import { sessionCookieValue, sessionPolicyForAuthMethod } from '../../assets/session-policy.mjs';
import { recordSecurityAudit } from '../../assets/security-audit-worker.js';
import { lineBrowserResponse } from '../../assets/line-browser-worker.mjs';
import { LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from '../../assets/line-browser-csp.mjs';
export const CONTENT_SECURITY_POLICY = `default-src 'self'; script-src 'self' ${LINE_BROWSER_SCRIPT_CSP}; style-src 'self' ${LINE_BROWSER_STYLE_CSP}; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
export const linkTarget = Object.freeze({ accountId: 'nobumi', displayLabel: '体調管理（田中暢美）', role: 'member', roleLabel: '共同管理', privileged: true, exclusive: false, shared: true, rootFolderId: null });
const COOKIE = 'troom_health_session';
const BASE = '/health';
const enc = new TextEncoder();
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
const enabled = env => env.PASSKEY_ENABLED === 'true';
const now = () => Math.floor(Date.now() / 1000);
function encode(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(text) { return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0)); }
async function signature(text, env) {
  requireSessionSecret(env.SESSION_SECRET, HttpError);
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encode(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export async function signSession(session, env) { const data = encode(enc.encode(JSON.stringify(session))); return `${data}.${await signature(data, env)}`; }
async function verifySession(token, env) {
  try {
    const [data, sig, extra] = String(token || '').split('.');
    if (extra || !data || !sig) return null;
    const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decode(sig), enc.encode(data))) return null;
    const s = JSON.parse(new TextDecoder().decode(decode(data)));
    return s.authMethod === 'passkey' && s.serviceAccountId === 'nobumi' && Number.isSafeInteger(s.expiresAt) && s.expiresAt > now() && s.sessionVersion === String(env.SESSION_VERSION || '1') ? s : null;
  } catch { return null; }
}
async function body(request, max = 200000) {
  const length = request.headers.get('Content-Length');
  if (length != null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > max)) throw new HttpError(413, '入力内容が大きすぎます。');
  let total = 0;
  const stream = request.body?.pipeThrough(new TransformStream({ transform(chunk, controller) {
    total += chunk.byteLength;
    if (total > max) throw new HttpError(413, '入力内容が大きすぎます。');
    controller.enqueue(chunk);
  } }));
  let value;
  try { value = await new Response(stream).json(); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, '入力形式を確認してください。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '入力形式を確認してください。');
  return value;
}
function mutation(request, url) { if (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(403, '不正なリクエストです。'); }
async function authorized(request, env) {
  if (!enabled(env)) throw new HttpError(503, 'パスキー機能は一時停止中です。');
  const cookie = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const session = await verifySession(cookie, env);
  if (!session) throw new HttpError(401, 'パスキーでログインしてください。');
  const result = await env.SECURITY.validatePasskeySession({ service: 'health', identityId: session.identityId, credentialId: session.credentialId, serviceLinkId: session.serviceLinkId, serviceAccountId: session.serviceAccountId, sessionEpoch: session.passkeySessionEpoch });
  if (result?.valid !== true) throw new HttpError(401, 'もう一度パスキーでログインしてください。');
  const key = await env.SECURITY.getHealthKeyBundle({ identityId: session.identityId, credentialId: session.credentialId, serviceLinkId: session.serviceLinkId });
  if (!key) throw new HttpError(403, 'Security Centerで利用準備と承認を完了してください。');
  if (request.headers.get('X-Health-Session') !== session.sessionId) throw new HttpError(409, '別のログインに切り替わりました。もう一度ログインしてください。');
  return session;
}
export async function handleRequest(request, env, context) {
  const blocked = lineBrowserResponse(request); if (blocked) return blocked;
  const url = new URL(request.url);
  if (url.pathname === BASE) return new Response(null, { status: 308, headers: { Location: `${BASE}/` } });
  const path = url.pathname.slice(BASE.length);
  if (!url.pathname.startsWith(`${BASE}/`)) throw new HttpError(404, '見つかりません。');
  if (!path.startsWith('/api/')) {
    const response = await env.ASSETS.fetch(new Request(new URL(path === '/' ? '/' : path, url.origin), request));
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store'); headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    return new Response(response.body, { status: response.status, headers });
  }
  requireSessionSecret(env.SESSION_SECRET, HttpError);
  if (request.method !== 'GET') mutation(request, url);
  if (path === '/api/passkey/handoff' && request.method === 'POST') {
    if (!enabled(env)) throw new HttpError(503, 'パスキー機能は一時停止中です。');
    const input = await body(request, 4096);
    const h = await env.SECURITY.redeemHandoff(input.handoffToken, 'health');
    if (!h || h.serviceAccountId !== 'nobumi') throw new HttpError(401, '体調管理を利用できるパスキーを確認できません。');
    const keyBundle = await env.SECURITY.getHealthKeyBundle(h);
    if (!keyBundle) throw new HttpError(403, 'Security Centerで利用準備と承認を完了してください。');
    const policy = sessionPolicyForAuthMethod(env, 'passkey');
    const session = { identityId: h.identityId, credentialId: h.credentialId, serviceLinkId: h.serviceLinkId, serviceAccountId: h.serviceAccountId, passkeySessionEpoch: h.sessionEpoch, authMethod: 'passkey', role: 'member', sessionVersion: String(env.SESSION_VERSION || '1'), sessionId: crypto.randomUUID(), startedAt: new Date().toISOString(), expiresAt: now() + policy.ttlSeconds };
    await recordSecurityAudit(env, request, { service: 'health', eventType: 'passkey_login_success', outcome: 'success', identityId: session.identityId, credentialId: session.credentialId, serviceLinkId: session.serviceLinkId, serviceAccountId: 'nobumi', role: 'member', authMethod: 'passkey', expiresAt: session.expiresAt, startedAt: session.startedAt, sessionVersion: session.sessionVersion, passkeySessionEpoch: session.passkeySessionEpoch, sessionId: session.sessionId });
    return json({ sessionId: session.sessionId, expiresAt: session.expiresAt, keyBundle }, 200, { 'Set-Cookie': sessionCookieValue(COOKIE, await signSession(session, env), BASE, policy, url.protocol === 'https:') });
  }
  const session = await authorized(request, env);
  if (path === '/api/logout' && request.method === 'POST') { await recordSecurityAudit(env, request, {service:'health',eventType:'logout',outcome:'success',identityId:session.identityId,credentialId:session.credentialId,serviceLinkId:session.serviceLinkId,serviceAccountId:'nobumi',role:'member',authMethod:'passkey',sessionId:session.sessionId}); return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=${BASE}; Max-Age=0; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}` }); }
  if (path === '/api/records' && request.method === 'GET') return json({ records: (await env.DB.prepare("SELECT record_id AS id, iv, ciphertext, revision FROM health_records WHERE account_id = 'nobumi' ORDER BY record_id").all()).results });
  if (path.startsWith('/api/records/')) {
    const id = path.slice('/api/records/'.length);
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new HttpError(400, '記録の識別子を確認してください。');
    if (request.method === 'PUT') {
      const v = await body(request);
      if (Object.keys(v).sort().join(',') !== 'ciphertext,iv' || !/^[A-Za-z0-9_-]{16}$/.test(v.iv) || typeof v.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{22,180000}$/.test(v.ciphertext)) throw new HttpError(400, '暗号化された記録だけを保存できます。');
      await env.DB.prepare("INSERT INTO health_records (record_id, account_id, iv, ciphertext) VALUES (?, 'nobumi', ?, ?) ON CONFLICT(record_id) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext, revision=health_records.revision+1, updated_at=CURRENT_TIMESTAMP").bind(id, v.iv, v.ciphertext).run();
      return json({ ok: true });
    }
    if (request.method === 'DELETE') { await env.DB.prepare("DELETE FROM health_records WHERE account_id='nobumi' AND record_id=?").bind(id).run(); return json({ ok: true }); }
  }
  throw new HttpError(404, '見つかりません。');
}
