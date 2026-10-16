import { WorkerEntrypoint } from 'cloudflare:workers';
import { requireSessionSecret, isValidSessionSecret } from '../../assets/session-secret.mjs';
import { lineBrowserResponse } from '../../assets/line-browser-worker.mjs';
import { LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from '../../assets/line-browser-csp.mjs';
import { serviceRollingSession, renewServiceSession, ROLLING_SESSION_VERSION } from '../../assets/passkey-rolling.mjs';
import { sessionCookieValue, sessionPolicyForAuthMethod } from '../../assets/session-policy.mjs';
import { recordSecurityAudit } from '../../assets/security-audit-worker.js';
import { HttpError, text, quantity, uuid, occurredAt, yearBounds, jstYear } from './domain.js';

const BASE = '/inventory', SERVICE = 'inventory', COOKIE = 'troom_inventory_session';
const encoder = new TextEncoder();
const authorized = new WeakMap();
const sessionVersion = (env, account) => `${env.SESSION_VERSION || '1'}:${account.session_version}`;
const enabled = env => String(env.PASSKEY_ENABLED || 'false') === 'true';
const accountRecord = env => env.DB.prepare("SELECT * FROM inventory_accounts WHERE id = 'owner' AND is_active = 1").first();

export default class InventoryWorker extends WorkerEntrypoint {
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
    return { service: SERVICE, displayName: '在庫照会', targets: account ? [linkTarget(account)] : [] };
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
  if (url.pathname === BASE) return Response.redirect(`${url.origin}${BASE}/`, 308);
  if (!url.pathname.startsWith(`${BASE}/`)) throw new HttpError(404, 'ページが見つかりません。');
  const path = url.pathname.slice(BASE.length);
  if (!path.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'この操作は利用できません。');
    const response = await env.ASSETS.fetch(new Request(new URL(path, url.origin), request));
    const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
    if (headers.has('Location')) {
      const destination = new URL(headers.get('Location'), url.origin);
      if (destination.origin !== url.origin) throw new HttpError(503, '画面を読み込めませんでした。');
      if (!destination.pathname.startsWith(`${BASE}/`)) destination.pathname = BASE + destination.pathname;
      headers.set('Location', destination.pathname + destination.search + destination.hash);
    }
    return new Response(response.body, { status: response.status, headers });
  }
  requireSessionSecret(env.SESSION_SECRET, HttpError);
  if (request.method !== 'GET') mutationGuard(request, url);
  if (path === '/api/passkey/handoff' && request.method === 'POST') return handoff(request, env, url);
  const session = await requireSession(request, env);
  authorized.set(request, session);
  if (path === '/api/session' && request.method === 'GET') {
    await audit(env, request, session, 'session_resume');
    const account = await accountRecord(env);
    return json({ authenticated: true, displayName: account.display_name });
  }
  if (path === '/api/logout' && request.method === 'POST') {
    if (!(await serviceRollingSession(env, SERVICE, session, 'end')).valid) throw new HttpError(503, 'ログアウトを完了できませんでした。');
    await audit(env, request, session, 'logout');
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=${BASE}; Max-Age=0; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}` });
  }
  if (path === '/api/items' && request.method === 'GET') {
    const { year, start, end } = yearBounds(url.searchParams.get('year') || jstYear());
    const items = await env.DB.prepare(`SELECT i.*, COALESCE((SELECT SUM(-m.quantity_delta) FROM inventory_movements m
      WHERE m.item_id = i.id AND m.account_id = i.account_id AND m.kind = 'use' AND m.voided_at IS NULL
      AND m.occurred_at >= ? AND m.occurred_at < ?), 0) AS annual_usage
      FROM inventory_items i WHERE account_id = ? AND deleted_at IS NULL ORDER BY archived_at IS NOT NULL, name, id`).bind(start, end, 'owner').all();
    return json({ year, items: items.results });
  }
  if (path === '/api/items' && request.method === 'POST') {
    const body = await readJson(request), requestId = uuid(body.requestId);
    const input = { name: text(body.name, 100, '品目名'), unit: text(body.unit, 12, '単位'), stock: quantity(body.stock, true) };
    return idempotent(env, requestId, { path, ...input }, async () => {
      const itemId = crypto.randomUUID(), movementId = crypto.randomUUID(), now = new Date().toISOString();
      return { value: { itemId, movementId }, statements: [
        env.DB.prepare('INSERT INTO inventory_items (id, account_id, name, unit, created_at) VALUES (?, ?, ?, ?, ?)').bind(itemId, 'owner', input.name, input.unit, now),
        env.DB.prepare("INSERT INTO inventory_movements (id, account_id, item_id, kind, quantity_delta, occurred_at, created_at) VALUES (?, ?, ?, 'opening', ?, ?, ?)").bind(movementId, 'owner', itemId, input.stock, now, now)
      ] };
    });
  }
  const itemRoute = /^\/api\/items\/([^/]+)(?:\/(movements|archive|delete))?$/.exec(path);
  if (itemRoute) {
    const itemId = uuid(itemRoute[1]);
    // Replay must precede the deleted-item lookup so a lost delete response is retryable.
    if (itemRoute[2] === 'delete' && request.method === 'POST') {
      const body = await readJson(request), expectedVersion = quantity(body.expectedVersion, true);
      return idempotent(env, uuid(body.requestId), { path, expectedVersion }, async () => {
        const existing = await env.DB.prepare('SELECT id FROM inventory_items WHERE id = ? AND account_id = ? AND deleted_at IS NULL').bind(itemId, 'owner').first();
        if (!existing) throw new HttpError(404, '品目が見つかりません。');
        return { value: { itemId }, statements: [env.DB.prepare('UPDATE inventory_items SET deleted_at = ?, version = ? WHERE id = ? AND account_id = ?')
          .bind(new Date().toISOString(), expectedVersion + 1, itemId, 'owner')] };
      });
    }
    const item = await env.DB.prepare('SELECT * FROM inventory_items WHERE id = ? AND account_id = ? AND deleted_at IS NULL').bind(itemId, 'owner').first();
    if (!item) throw new HttpError(404, '品目が見つかりません。');
    if (!itemRoute[2] && request.method === 'GET') {
      const { year, start, end } = yearBounds(url.searchParams.get('year') || jstYear());
      const grouped = await env.DB.prepare(`SELECT CAST(strftime('%m', occurred_at, '+9 hours') AS INTEGER) AS month,
        SUM(-quantity_delta) AS used FROM inventory_movements WHERE account_id = ? AND item_id = ?
        AND kind = 'use' AND voided_at IS NULL AND occurred_at >= ? AND occurred_at < ? GROUP BY month`).bind('owner', itemId, start, end).all();
      const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, used: Number(grouped.results.find(r => r.month === i + 1)?.used || 0) }));
      const cursor = url.searchParams.get('before') || '';
      let cursorTime = '', cursorId = '';
      if (cursor) {
        const fields = cursor.split('|');
        if (fields.length !== 2) throw new HttpError(400, '履歴のページを確認してください。');
        cursorTime = occurredAt(fields[0]); cursorId = uuid(fields[1]);
      }
      const history = await env.DB.prepare(`SELECT * FROM inventory_movements WHERE account_id = ? AND item_id = ?
        AND occurred_at >= ? AND occurred_at < ? ${cursor ? 'AND (occurred_at < ? OR (occurred_at = ? AND id < ?))' : ''}
        ORDER BY occurred_at DESC, id DESC LIMIT 51`).bind('owner', itemId, start, end, ...(cursor ? [cursorTime, cursorTime, cursorId] : [])).all();
      const rows = history.results.slice(0, 50), last = rows.at(-1);
      return json({ item, year, months, annualUsage: months.reduce((n, m) => n + m.used, 0), movements: rows, nextCursor: history.results.length > 50 ? `${last.occurred_at}|${last.id}` : null });
    }
    if (itemRoute[2] === 'movements' && request.method === 'POST') {
      const body = await readJson(request), requestId = uuid(body.requestId);
      if (!['use', 'restock', 'adjust'].includes(body.kind)) throw new HttpError(400, '記録の種類を確認してください。');
      const amount = quantity(body.quantity, body.kind === 'adjust'), time = occurredAt(body.occurredAt);
      const expectedVersion = body.kind === 'adjust' ? quantity(body.expectedVersion, true) : null;
      const input = { path, kind: body.kind, quantity: amount, occurredAt: time, expectedVersion };
      return idempotent(env, requestId, input, async () => {
        if (item.archived_at) throw new HttpError(409, 'アーカイブ済みの品目には追加できません。');
        const delta = body.kind === 'adjust' ? amount - item.stock : body.kind === 'use' ? -amount : amount;
        const movementId = crypto.randomUUID();
        return { value: { itemId, movementId }, statements: [env.DB.prepare(`INSERT INTO inventory_movements
          (id, account_id, item_id, kind, quantity_delta, expected_version, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(movementId, 'owner', itemId, body.kind, delta, expectedVersion, time, new Date().toISOString())] };
      });
    }
    if (itemRoute[2] === 'archive' && request.method === 'POST') {
      const body = await readJson(request);
      return idempotent(env, uuid(body.requestId), { path }, async () => ({ value: { itemId }, statements: [
        env.DB.prepare('UPDATE inventory_items SET archived_at = ?, version = version + 1 WHERE id = ? AND account_id = ?').bind(new Date().toISOString(), itemId, 'owner')
      ] }));
    }
  }
  const voidRoute = /^\/api\/movements\/([^/]+)\/void$/.exec(path);
  if (voidRoute && request.method === 'POST') {
    const id = uuid(voidRoute[1]), body = await readJson(request);
    return idempotent(env, uuid(body.requestId), { path }, async () => {
      const movement = await env.DB.prepare('SELECT * FROM inventory_movements WHERE id = ? AND account_id = ?').bind(id, 'owner').first();
      if (!movement) throw new HttpError(404, '記録が見つかりません。');
      return { value: { itemId: movement.item_id, movementId: id }, statements: [
        env.DB.prepare('UPDATE inventory_movements SET voided_at = ? WHERE id = ? AND account_id = ?').bind(new Date().toISOString(), id, 'owner')
      ] };
    });
  }
  throw new HttpError(404, 'ページが見つかりません。');
}

async function idempotent(env, requestId, input, prepare) {
  const fingerprint = toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(input)))));
  async function replay() {
    const row = await env.DB.prepare('SELECT fingerprint, response_json FROM inventory_requests WHERE account_id = ? AND request_id = ?').bind('owner', requestId).first();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, '同じ操作IDで異なる内容を送信できません。', 'replay_conflict');
    return json(JSON.parse(row.response_json));
  }
  const existing = await replay(); if (existing) return existing;
  const { value, statements } = await prepare();
  try {
    await env.DB.batch([env.DB.prepare('INSERT INTO inventory_requests VALUES (?, ?, ?, ?, ?)')
      .bind('owner', requestId, fingerprint, JSON.stringify(value), new Date().toISOString()), ...statements]);
  } catch (error) {
    const duplicate = await replay(); if (duplicate) return duplicate;
    const message = String(error?.message || '');
    if (/inventory_version_conflict/.test(message)) throw new HttpError(409, '別の操作で在庫が変わりました。再読み込みして入力し直してください。', 'version_conflict');
    if (/inventory_opening_required/.test(message)) throw new HttpError(409, '初期在庫は取り消せません。在庫調整を利用してください。');
    if (/inventory_movement_immutable/.test(message)) throw new HttpError(409, 'この記録は既に取り消されています。');
    if (/inventory_item_deleted/.test(message)) throw new HttpError(409, '削除済みの品目は変更できません。');
    if (/inventory_item_unavailable|inventory_archive_conflict/.test(message)) throw new HttpError(409, '在庫0の有効な品目だけをアーカイブできます。');
    if (/CHECK constraint failed/.test(message)) throw new HttpError(409, '在庫が不足しているか、数量の上限を超えています。取消できない場合は在庫調整を利用してください。', 'stock_conflict');
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
