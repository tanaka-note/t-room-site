import { foregroundSessionActivity, serviceRollingSession, renewServiceSession, ROLLING_SESSION_VERSION } from "../../assets/passkey-rolling.mjs";
import { isValidSessionSecret, requireSessionSecret } from "../../assets/session-secret.mjs";
import { lineBrowserResponse } from "../../assets/line-browser-worker.mjs";
import { validatePasswordSession } from "../../assets/password-auth-policy.mjs";
import { accountDisplayName } from "../../assets/account-display.mjs";
import { monthBounds, signedDocumentAmount, summarizeSettlements } from "./finance.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { enqueueSecurityAudit, recordSecurityAudit, withPasswordLoginAudit, handlePasswordLoginClientAudit } from "../../assets/security-audit-worker.js";
import { validateServicePasskeySession } from "../../assets/passkey-session-validation.mjs";
import { PASSWORD_SESSION_TTL_SECONDS, sessionCookieValue, sessionPolicyForAuthMethod, validSessionLifetime, sessionExpiresAt } from "../../assets/session-policy.mjs";

const BASE_PATH = "/billing";
const SESSION_COOKIE = "troom_billing_session";
const MAX_SESSION_SECONDS = PASSWORD_SESSION_TTL_SECONDS;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SecurityIntegration extends WorkerEntrypoint {
  async getSessionRuntimeState(input) {
    const account = await this.env.DB.prepare("SELECT session_version, is_active FROM billing_accounts WHERE id = ?")
      .bind(String(input?.serviceAccountId || "")).first();
    return account?.is_active ? {
      sessionVersion: `${String(this.env.SESSION_VERSION || "1")}:${Number(account.session_version || 1)}`,
      passkeyEnabled: String(this.env.PASSKEY_ENABLED || "false") === "true"
    } : null;
  }

  async listLinkTargets() {
    const rows = await this.env.DB.prepare(`
      SELECT id, display_name, role FROM billing_accounts
      WHERE is_active = 1 ORDER BY display_name COLLATE NOCASE, id
    `).all();
    return {
      service: "billing",
      displayName: "請求書",
      targets: (rows.results || []).map(billingLinkTarget)
    };
  }

  async describeAccount(input) {
    const account = await this.env.DB.prepare("SELECT id, display_name, role FROM billing_accounts WHERE id = ? AND is_active = 1")
      .bind(String(input?.accountId || "")).first();
    return account ? { valid: true, ...billingLinkTarget(account) } : { valid: false };
  }
}

function billingLinkTarget(account) {
  const roleLabel = account.role === "owner" ? "管理者" : "一般ユーザー";
  return {
    accountId: account.id,
    displayLabel: accountDisplayName({ service: "billing", accountId: account.id, role: account.role }, `${account.display_name}（${roleLabel}）`),
    role: account.role,
    roleLabel,
    privileged: account.role === "owner",
    exclusive: true,
    shared: false,
    rootFolderId: null
  };
}

export default {
  async fetch(request, env, context) {
    const browserResponse = lineBrowserResponse(request);
    if (browserResponse) return browserResponse;
    try {
      const url = new URL(request.url);
      if (!isAllowedProtocol(url, env)) return secureResponse(json({ error: "HTTPSでアクセスしてください。" }, 403));
      if (url.pathname === BASE_PATH) {
        return secureResponse(Response.redirect(`${url.origin}${BASE_PATH}/`, 308));
      }
      const path = url.pathname.startsWith(BASE_PATH)
        ? url.pathname.slice(BASE_PATH.length) || "/"
        : url.pathname;

      if (path.startsWith("/api/")) {
        // Only this request shares the initial read. Rolling responses still
        // require a live touch and a final local account check before release.
        let sessionPromise;
        const getSession = () => (sessionPromise ??= readSession(request, env));
        const response = await withPasswordLoginAudit(env, request, "billing", () => handleApi(request, env, url, path, context, getSession));
        return secureResponse(await refreshAuthenticatedSession(request, response, env, url, path, getSession));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return secureResponse(json({ error: "Method not allowed" }, 405));
      }
      return secureResponse(await serveAsset(request, env, url, path));
    } catch (error) {
      if (error instanceof HttpError) return secureResponse(json({ error: error.message }, error.status));
      console.error("Billing request failed", new URL(request.url).pathname.endsWith("/api/login") ? "password_login_error" : (error instanceof Error ? error.message : "unknown error"));
      return secureResponse(json({ error: "読み込みに失敗しました。時間を置いてもう一度お試しください。" }, 500));
    }
  }
};

async function handleApi(request, env, url, path, context, getSession) {
  requireSessionSecret(env.SESSION_SECRET, HttpError);
  if (path === "/api/password-login-audit" && request.method === "POST") return handlePasswordLoginClientAudit(env, request, "billing");
  if (path === "/api/session" && request.method === "GET") {
    const session = await getSession();
    if (session) await recordSecurityAudit(env, request, {
      service: "billing", eventType: "session_resume", outcome: "success",
      identityId: session.identityId, serviceLinkId: session.serviceLinkId,
      serviceAccountId: session.accountId, role: session.role,
      authMethod: session.authMethod, sessionId: session.sessionId, credentialId: session.credentialId,
      expiresAt: session.exp,
      startedAt: session.startedAt,
      sessionVersion: billingSessionVersion(env, session.accountVersion), passkeySessionEpoch: session.passkeySessionEpoch
    });
    return json({
      authenticated: Boolean(session),
      expiresAt: session?.exp || null,
      role: session?.role || null,
      accountId: session?.accountId || null,
      accountName: session?.accountName || null,
      accountDisplayName: session ? accountDisplayName({ service: "billing", accountId: session.accountId, role: session.role }, `${session.accountName}${session.role === "owner" ? "（管理者）" : ""}`) : null,
      authMethod: session?.authMethod || null
    });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    // Retired for the entire service, including future accounts. Never read
    // credentials or change account/lockout state for cached password clients.
    await recordSecurityAudit(env, request, {
      service: "billing", eventType: "password_login_failure", outcome: "failure", authMethod: "password",
      details: { stage: "authentication", reason: "password_auth_disabled", counterUpdated: false }
    });
    throw new HttpError(401, "パスワードログインは廃止されました。登録済みのパスキーでログインしてください。準備・復旧はSecurity Centerで行ってください。");
  }

  if (path === "/api/passkey/handoff" && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    if (String(env.PASSKEY_ENABLED || "true") !== "true" || !env.SECURITY) throw new HttpError(503, "パスキー機能は一時停止中です。管理者へお問い合わせください。準備・復旧はSecurity Centerで行ってください。");
    const body = await readJson(request, 4096);
    const handoff = await env.SECURITY.redeemHandoff(String(body.handoffToken || ""), "billing");
    if (!handoff) throw new HttpError(401, "パスキー認証の有効期限が切れています。もう一度お試しください。");
    const account = await env.DB.prepare("SELECT id, display_name, role, session_version, is_active FROM billing_accounts WHERE id = ?").bind(handoff.serviceAccountId).first();
    if (!account?.is_active) throw new HttpError(403, "請求書管理の連携先アカウントを確認できません。");
    const policy = sessionPolicy(env, "passkey");
    const sessionId = crypto.randomUUID();
    const token = await createSessionToken(account, policy.ttlSeconds, env, {
      identityId: handoff.identityId,
      credentialId: handoff.credentialId,
      serviceLinkId: handoff.serviceLinkId,
      serviceAccountId: handoff.serviceAccountId,
      passkeySessionEpoch: handoff.sessionEpoch,
      authMethod: "passkey",
      rollingSessionVersion: ROLLING_SESSION_VERSION,
      sessionId,
      startedAt: new Date().toISOString()
    });
    const headers = new Headers({ "Set-Cookie": sessionCookie(token, policy, url.protocol === "https:") });
    await writeAudit(env, { eventType: "passkey_login_success", actorAccountId: account.id, targetAccountId: account.id });
    await recordSecurityAudit(env, request, { service: "billing", eventType: "passkey_login_success", outcome: "success", identityId: handoff.identityId, serviceLinkId: handoff.serviceLinkId, serviceAccountId: account.id, role: account.role, authMethod: "passkey", sessionId, credentialId: handoff.credentialId, expiresAt: Math.floor(Date.now() / 1000) + policy.ttlSeconds, startedAt: new Date().toISOString(), sessionVersion: billingSessionVersion(env, account.session_version), passkeySessionEpoch: handoff.sessionEpoch });
    return json({ authenticated: true, role: account.role, accountId: account.id, accountName: account.display_name, accountDisplayName: accountDisplayName({ service: "billing", accountId: account.id, role: account.role }, `${account.display_name}${account.role === "owner" ? "（管理者）" : ""}`), authMethod: "passkey" }, 200, headers);
  }

  if (path === "/api/logout" && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    const session = await getSession();
    if (session?.rollingSessionVersion != null && !(await serviceRollingSession(env, "billing", session, "end")).valid) throw new HttpError(503, "ログアウトを完了できませんでした。");
    if (session) {
      await writeAudit(env, { eventType: "logout", actorAccountId: session.accountId });
      await recordSecurityAudit(env, request, { service: "billing", eventType: "logout", outcome: "success", identityId: session.identityId, serviceLinkId: session.serviceLinkId, serviceAccountId: session.accountId, role: session.role, authMethod: session.authMethod, sessionId: session.sessionId });
    }
    const headers = new Headers();
    headers.set("Set-Cookie", clearSessionCookie(url.protocol === "https:"));
    return json({ ok: true }, 200, headers);
  }

  const session = await getSession();
  if (!session) throw new HttpError(401, "ログインが必要です。");
  if (request.method !== "GET" && !validMutationRequest(request, url)) {
    throw new HttpError(403, "不正なリクエストです。");
  }

  if (path === "/api/accounts" && request.method === "GET") {
    const accounts = await listAccounts(env, session);
    if (url.searchParams.get("includeSummary") !== "1") return json({ accounts });
    const account = session.role === "owner" ? accounts[0] : accounts.find(a => a.id === session.accountId);
    if (!account) throw new HttpError(404, "利用者が見つかりません。");
    const summary = await getSummary(url, env, session, account);
    auditSummaryAccess(env, context, request, session, summary.account.id);
    return json({ accounts, summary });
  }
  if (path === "/api/summary" && request.method === "GET") {
    const summary = await getSummary(url, env, session);
    auditSummaryAccess(env, context, request, session, summary.account.id);
    return json(summary);
  }
  if (path === "/api/entries" && request.method === "POST") {
    requireOwner(session);
    return createEntry(request, env, session);
  }
  if (path === "/api/settlements" && request.method === "POST") {
    requireOwner(session);
    return createSettlement(request, env, session);
  }
  if (path === "/api/audit-logs" && request.method === "GET") {
    requireOwner(session);
    return listAuditLogs(url, env);
  }

  const entryMatch = path.match(/^\/api\/entries\/(\d+)$/);
  if (entryMatch && request.method === "PUT") {
    requireOwner(session);
    return updateEntry(Number(entryMatch[1]), request, env, session);
  }
  if (entryMatch && request.method === "DELETE") {
    requireOwner(session);
    return deleteEntry(Number(entryMatch[1]), env, session);
  }

  const settlementMatch = path.match(/^\/api\/settlements\/(\d+)$/);
  if (settlementMatch && request.method === "PUT") {
    requireOwner(session);
    return updateSettlement(Number(settlementMatch[1]), request, env, session);
  }
  if (settlementMatch && request.method === "DELETE") {
    requireOwner(session);
    return deleteSettlement(Number(settlementMatch[1]), env, session);
  }

  throw new HttpError(404, "Not found");
}

async function listAccounts(env, session) {
  if (session.role !== "owner") {
    return [{ id: session.accountId, displayName: session.accountName, role: session.role }];
  }
  const result = await env.DB.prepare(`
    SELECT id, display_name, role FROM billing_accounts
    WHERE is_active = 1 AND role = 'member'
    ORDER BY CASE id
      WHEN 'chiharu' THEN 1 WHEN 'hideaki' THEN 2 WHEN 'masami' THEN 3 WHEN 'yuuka' THEN 4
      WHEN 'machiko' THEN 5 ELSE 99 END
  `).all();
  return (result.results || []).map((row) => ({ id: row.id, displayName: row.display_name, role: row.role }));
}

function auditSummaryAccess(env, context, request, session, targetAccountId) {
  if (session.role === "owner" && targetAccountId !== session.accountId) {
    enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "admin_access", outcome: "success", identityId: session.identityId, serviceAccountId: session.accountId, role: session.role, authMethod: session.authMethod, targetType: "billing_account", targetId: targetAccountId });
  }
}

async function getSummary(url, env, session, selectedAccount = null) {
  const account = selectedAccount || await resolveSummaryAccount(url.searchParams.get("accountId"), env, session);
  const accountId = account.id;
  const month = validMonth(url.searchParams.get("month")) || currentJapanMonth();
  const bounds = monthBounds(month);
  // One D1 round trip and snapshot for lists and balances. Each historical
  // table is aggregated once; the existing signed-yen formulas stay in SQL.
  const [entriesResult, settlementsResult, documentsResult, balancesResult] = await env.DB.batch([
    env.DB.prepare(`
    SELECT id, document_type, entry_date, category, amount_yen, description, note, created_at, updated_at
    FROM billing_entries
    WHERE account_id = ? AND deleted_at IS NULL AND category != 'income'
      AND entry_date >= ? AND entry_date < ?
    ORDER BY entry_date, id
  `).bind(accountId, bounds.start, bounds.next),
    env.DB.prepare(`
    SELECT id, settlement_date, direction, method, amount_yen, note, created_at, updated_at
    FROM billing_settlements
    WHERE account_id = ? AND deleted_at IS NULL AND settlement_date >= ? AND settlement_date < ?
    ORDER BY settlement_date, id
  `).bind(accountId, bounds.start, bounds.next),
    env.DB.prepare(`
    SELECT COALESCE(SUM(CASE WHEN entry_date < ? THEN
      CASE document_type WHEN 'invoice' THEN amount_yen ELSE -amount_yen END ELSE 0 END), 0) AS opening,
      COALESCE(SUM(CASE document_type WHEN 'invoice' THEN amount_yen ELSE -amount_yen END), 0) AS closing
    FROM billing_entries
    WHERE account_id = ? AND deleted_at IS NULL AND category != 'income' AND entry_date < ?
  `).bind(bounds.start, accountId, bounds.next),
    env.DB.prepare(`
    SELECT COALESCE(SUM(CASE WHEN settlement_date < ? THEN
      CASE WHEN method = 'offset' THEN 0 WHEN direction = 'incoming' THEN -amount_yen ELSE amount_yen END ELSE 0 END), 0) AS opening,
      COALESCE(SUM(CASE WHEN method = 'offset' THEN 0 WHEN direction = 'incoming' THEN -amount_yen ELSE amount_yen END), 0) AS closing
    FROM billing_settlements
    WHERE account_id = ? AND deleted_at IS NULL AND settlement_date < ?
  `).bind(bounds.start, accountId, bounds.next)
  ]);
  const entries = (entriesResult.results || []).map(serializeEntry);
  const settlements = (settlementsResult.results || []).map(serializeSettlement);
  const documents = documentsResult.results[0], balances = balancesResult.results[0];
  const settlementTotals = summarizeSettlements(settlements);
  return {
    account: { id: account.id, displayName: account.displayName },
    month,
    openingBalanceYen: Number(documents.opening) + Number(balances.opening),
    closingBalanceYen: Number(documents.closing) + Number(balances.closing),
    entries,
    settlements,
    settlementTotals
  };
}

async function resolveSummaryAccount(requested, env, session) {
  const member = session.role !== "owner";
  const target = member ? session.accountId : normalizeAccountId(requested);
  const account = target
    ? await env.DB.prepare(`SELECT id, display_name FROM billing_accounts WHERE id = ? AND is_active = 1${member ? "" : " AND role = 'member'"}`).bind(target).first()
    : await env.DB.prepare(`SELECT id, display_name FROM billing_accounts WHERE role = 'member' AND is_active = 1
        ORDER BY CASE id WHEN 'chiharu' THEN 1 WHEN 'hideaki' THEN 2 WHEN 'masami' THEN 3 WHEN 'yuuka' THEN 4 WHEN 'machiko' THEN 5 ELSE 99 END LIMIT 1`).first();
  if (!account) throw new HttpError(404, "利用者が見つかりません。");
  return { id: account.id, displayName: account.display_name };
}

async function createEntry(request, env, session) {
  const input = await parseEntryInput(request, env);
  const result = await env.DB.prepare(`
    INSERT INTO billing_entries (account_id, document_type, entry_date, category, amount_yen, description, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.accountId, input.documentType, input.entryDate, input.category,
    input.amountYen, input.description, input.note, session.accountId
  ).run();
  const id = Number(result.meta?.last_row_id);
  await writeAudit(env, {
    eventType: "entry_created",
    actorAccountId: session.accountId,
    targetAccountId: input.accountId,
    entryId: id,
    details: input
  });
  return json({ ok: true, id }, 201);
}

async function updateEntry(id, request, env, session) {
  const existing = await env.DB.prepare(`
    SELECT id, account_id, document_type, entry_date, category, amount_yen, description, note
    FROM billing_entries WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first();
  if (!existing) throw new HttpError(404, "明細が見つかりません。");
  const input = await parseEntryInput(request, env);
  await env.DB.prepare(`
    UPDATE billing_entries SET account_id = ?, document_type = ?, entry_date = ?, category = ?, amount_yen = ?,
      description = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).bind(
    input.accountId, input.documentType, input.entryDate, input.category,
    input.amountYen, input.description, input.note, id
  ).run();
  await writeAudit(env, {
    eventType: "entry_updated",
    actorAccountId: session.accountId,
    targetAccountId: input.accountId,
    entryId: id,
    details: { previous: existing, next: input }
  });
  return json({ ok: true });
}

async function deleteEntry(id, env, session) {
  const existing = await env.DB.prepare(`
    SELECT id, account_id, document_type, entry_date, category, amount_yen, description, note
    FROM billing_entries WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first();
  if (!existing) throw new HttpError(404, "明細が見つかりません。");
  await env.DB.prepare(`UPDATE billing_entries SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
  await writeAudit(env, {
    eventType: "entry_deleted",
    actorAccountId: session.accountId,
    targetAccountId: existing.account_id,
    entryId: id,
    details: existing
  });
  return json({ ok: true });
}

async function parseEntryInput(request, env) {
  const body = await readJson(request, 16384);
  const accountId = normalizeAccountId(body.accountId);
  const documentType = ["invoice", "payment_notice"].includes(body.documentType) ? body.documentType : "";
  const entryDate = normalizeDate(body.entryDate);
  const allowedCategories = documentType === "invoice"
    ? ["purchase", "discount", "offset", "other"]
    : ["purchase", "offset", "other"];
  const category = allowedCategories.includes(body.category) ? body.category : "";
  const amount = normalizeInteger(body.amountYen, 1, 999999999999);
  const otherDirection = body.otherDirection === "minus" ? "minus" : "plus";
  const description = normalizeText(body.description, 100);
  const note = normalizeText(body.note, 500, true);
  if (!accountId || !documentType || !entryDate || !category || amount === null || !description) {
    throw new HttpError(400, "明細の入力内容を確認してください。");
  }
  await assertTargetAccountExists(accountId, env);
  return {
    accountId,
    documentType,
    entryDate,
    category,
    amountYen: signedDocumentAmount(category, amount, otherDirection),
    description,
    note
  };
}

async function createSettlement(request, env, session) {
  const input = await parseSettlementInput(request, env);
  const result = await env.DB.prepare(`
    INSERT INTO billing_settlements
      (account_id, settlement_date, direction, method, amount_yen, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.accountId, input.settlementDate, input.direction, input.method,
    input.amountYen, input.note, session.accountId
  ).run();
  const id = Number(result.meta?.last_row_id);
  await writeAudit(env, {
    eventType: "settlement_created",
    actorAccountId: session.accountId,
    targetAccountId: input.accountId,
    details: { id, ...input }
  });
  return json({ ok: true, id }, 201);
}

async function updateSettlement(id, request, env, session) {
  const existing = await env.DB.prepare(`
    SELECT id, account_id, settlement_date, direction, method, amount_yen, note
    FROM billing_settlements WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first();
  if (!existing) throw new HttpError(404, "入出金履歴が見つかりません。");
  const input = await parseSettlementInput(request, env);
  await env.DB.prepare(`
    UPDATE billing_settlements SET account_id = ?, settlement_date = ?, direction = ?,
      method = ?, amount_yen = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).bind(
    input.accountId, input.settlementDate, input.direction, input.method,
    input.amountYen, input.note, id
  ).run();
  await writeAudit(env, {
    eventType: "settlement_updated",
    actorAccountId: session.accountId,
    targetAccountId: input.accountId,
    details: { id, previous: existing, next: input }
  });
  return json({ ok: true });
}

async function deleteSettlement(id, env, session) {
  const existing = await env.DB.prepare(`
    SELECT id, account_id, settlement_date, direction, method, amount_yen, note
    FROM billing_settlements WHERE id = ? AND deleted_at IS NULL
  `).bind(id).first();
  if (!existing) throw new HttpError(404, "入出金履歴が見つかりません。");
  await env.DB.prepare(`
    UPDATE billing_settlements SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).bind(id).run();
  await writeAudit(env, {
    eventType: "settlement_deleted",
    actorAccountId: session.accountId,
    targetAccountId: existing.account_id,
    details: existing
  });
  return json({ ok: true });
}

async function parseSettlementInput(request, env) {
  const body = await readJson(request, 16384);
  const accountId = normalizeAccountId(body.accountId);
  const settlementDate = normalizeDate(body.settlementDate);
  const direction = ["incoming", "outgoing"].includes(body.direction) ? body.direction : "";
  const method = ["bank_transfer", "cash", "offset", "other"].includes(body.method) ? body.method : "";
  const amountYen = normalizeInteger(body.amountYen, 1, 999999999999);
  const note = normalizeText(body.note, 500, true);
  if (!accountId || !settlementDate || !direction || !method || amountYen === null) {
    throw new HttpError(400, "入出金の入力内容を確認してください。");
  }
  await assertTargetAccountExists(accountId, env);
  return { accountId, settlementDate, direction, method, amountYen, note };
}

async function listAuditLogs(url, env) {
  const limit = clampNumber(url.searchParams.get("limit"), 1, 200, 100);
  const accountId = normalizeAccountId(url.searchParams.get("accountId"));
  if (accountId) {
    const account = await env.DB.prepare(`
      SELECT id FROM billing_accounts WHERE id = ? AND is_active = 1
    `).bind(accountId).first();
    if (!account) throw new HttpError(404, "アカウントが見つかりません。");
  }
  const filterSql = accountId
    ? `WHERE l.actor_account_id = ? OR (
        l.actor_account_id IS NULL
        AND l.target_account_id = ?
        AND l.event_type IN ('login_failure', 'login_locked', 'login_blocked')
      )`
    : "";
  const result = await env.DB.prepare(`
    SELECT l.id, l.event_type, l.actor_account_id, l.target_account_id, l.entry_id,
      l.attempted_login_id, l.details_json, l.occurred_at,
      actor.display_name AS actor_name, target.display_name AS target_name
    FROM billing_audit_logs l
    LEFT JOIN billing_accounts actor ON actor.id = l.actor_account_id
    LEFT JOIN billing_accounts target ON target.id = l.target_account_id
    ${filterSql}
    ORDER BY l.occurred_at DESC, l.id DESC LIMIT ?
  `).bind(...(accountId ? [accountId, accountId] : []), limit).all();
  return json({ logs: (result.results || []).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorName: row.actor_name || null,
    targetName: row.target_name || null,
    attemptedLoginId: row.attempted_login_id || null,
    entryId: row.entry_id || null,
    occurredAt: row.occurred_at
  })) });
}

async function serveAsset(request, env, url, path) {
  if (!env.ASSETS) return new Response("Billing assets are not configured", { status: 503 });
  const assetPaths = new Map([
    ["/manifest.webmanifest", "/manifest.webmanifest"],
    ["/billing.css", "/billing.css"],
    ["/billing.js", "/billing.js"],
    ["/password-login-audit.js", "/password-login-audit.js"],
    ["/troom-date-picker.css", "/troom-date-picker.css"],
    ["/troom-date-picker.js", "/troom-date-picker.js"]
  ]);
  const isAppRoute = path === "/";
  const assetPath = assetPaths.get(path) || (isAppRoute ? "/" : null);
  if (!assetPath) return new Response("Not found", { status: 404 });
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", assetPath === "/" ? "no-store" : "public, max-age=3600");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readSession(request, env) {
  if (!isValidSessionSecret(env.SESSION_SECRET)) return null;
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!token) return null;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  const expected = await sign(encodedPayload, env.SESSION_SECRET);
  if (!constantTimeEqual(base64UrlToBytes(signature), base64UrlToBytes(expected))) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(encodedPayload)));
    if (!(await validatePasswordSession(payload, env, "billing"))) return null;
    if (!validSessionLifetime(payload)) return null;
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (String(payload.globalVersion) !== String(env.SESSION_VERSION || "1")) return null;
    const account = await env.DB.prepare(`
      SELECT id, display_name, role, session_version, is_active FROM billing_accounts WHERE id = ?
    `).bind(payload.accountId).first();
    if (!account?.is_active || account.role !== payload.role || Number(account.session_version) !== Number(payload.accountVersion)) return null;
    if (!(await validateServicePasskeySession(payload, env, "billing"))) return null;
    return {
      accountId: account.id,
      accountName: account.display_name,
      role: account.role,
      identityId: payload.identityId || null,
      credentialId: payload.credentialId || null,
      serviceLinkId: payload.serviceLinkId || null,
      serviceAccountId: payload.serviceAccountId || null,
      passkeySessionEpoch: payload.passkeySessionEpoch || null,
      authMethod: payload.authMethod,
      sessionId: payload.sessionId || null,
      startedAt: payload.startedAt || null,
      exp: Number(payload.exp),
      rollingSessionVersion: payload.rollingSessionVersion,
      accountVersion: Number(payload.accountVersion || 1),
      globalVersion: String(payload.globalVersion)
    };
  } catch {
    return null;
  }
}

async function createSessionToken(account, maxAge, env, auth = {}) {
  requireSessionSecret(env.SESSION_SECRET, HttpError);
  if (auth.authMethod !== "passkey") throw new HttpError(401, "パスキー認証が必要です。");
  const payload = {
    accountId: account.id,
    role: account.role,
    accountVersion: Number(account.session_version),
    globalVersion: String(env.SESSION_VERSION || "1"),
    identityId: auth.identityId || null,
    credentialId: auth.credentialId || null,
    serviceLinkId: auth.serviceLinkId || null,
    serviceAccountId: auth.serviceAccountId || null,
    passkeySessionEpoch: auth.passkeySessionEpoch || null,
    authMethod: auth.authMethod,
    ...(auth.rollingSessionVersion != null ? { rollingSessionVersion: auth.rollingSessionVersion } : {}),
    sessionId: auth.sessionId || crypto.randomUUID(),
    startedAt: Object.hasOwn(auth, "startedAt") ? (auth.startedAt || null) : new Date().toISOString(),
    exp: sessionExpiresAt(Math.floor(Date.now() / 1000), sessionPolicyForAuthMethod(env, auth.authMethod, maxAge), auth.expiresAt)
  };
  if (payload.rollingSessionVersion === ROLLING_SESSION_VERSION && auth.expiresAt == null
    && !(await serviceRollingSession(env, "billing", payload, "register")).valid) throw new HttpError(503, "セッションを開始できませんでした。");
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, env.SESSION_SECRET)}`;
}

function sessionMaxAge(env) {
  return clampNumber(env.SESSION_TTL_SECONDS, 3600, MAX_SESSION_SECONDS, MAX_SESSION_SECONDS);
}

function sessionPolicy(env, authMethod) {
  return sessionPolicyForAuthMethod(env, authMethod, sessionMaxAge(env));
}

function billingSessionVersion(env, accountVersion) { return `${String(env.SESSION_VERSION || "1")}:${Number(accountVersion || 1)}`; }

async function refreshAuthenticatedSession(request, response, env, url, path, getSession) {
  if (!foregroundSessionActivity(request, response, path)) return response;
  let session = await getSession();
  // Legacy sessions cannot touch. Keep their final live read rather than reusing
  // the first check without an equivalent Security revocation check.
  if (session?.rollingSessionVersion !== ROLLING_SESSION_VERSION) session = await readSession(request, env);
  if (!session || session.exp <= Math.floor(Date.now() / 1000) || String(env.PASSKEY_ENABLED || "true") !== "true") throw new HttpError(401, "パスキーでログインし直してください。");
  return renewServiceSession(request, response, env, "billing", path, session, async expiresAt => {
    const account = await env.DB.prepare("SELECT id, role, session_version FROM billing_accounts WHERE id = ? AND is_active = 1").bind(session.accountId).first();
    // A role/version change during data retrieval must never mint a cookie
    // for the changed authority or release the previously prepared response.
    if (!account || account.role !== session.role || Number(account.session_version) !== session.accountVersion
      || session.globalVersion !== String(env.SESSION_VERSION || "1")) throw new HttpError(401, "パスキーでログインし直してください。");
    const policy = sessionPolicy(env, "passkey");
    const token = await createSessionToken(account, policy.ttlSeconds, env, { ...session, expiresAt });
    return sessionCookie(token, policy, url.protocol === "https:");
  });
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function assertTargetAccountExists(accountId, env) {
  const row = await env.DB.prepare(`
    SELECT id FROM billing_accounts WHERE id = ? AND role = 'member' AND is_active = 1
  `).bind(accountId).first();
  if (!row) throw new HttpError(404, "利用者が見つかりません。");
}

async function writeAudit(env, input) {
  await env.DB.prepare(`
    INSERT INTO billing_audit_logs
      (event_type, actor_account_id, target_account_id, entry_id, attempted_login_id, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    input.eventType,
    input.actorAccountId || null,
    input.targetAccountId || null,
    input.entryId || null,
    input.attemptedLoginId || null,
    JSON.stringify(input.details || {})
  ).run();
}

function serializeEntry(row) {
  return {
    id: Number(row.id),
    documentType: row.document_type,
    entryDate: row.entry_date,
    category: row.category,
    amountYen: Number(row.amount_yen),
    description: row.description,
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeSettlement(row) {
  return {
    id: Number(row.id),
    settlementDate: row.settlement_date,
    direction: row.direction,
    method: row.method,
    amountYen: Number(row.amount_yen),
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(value, status = 200, inputHeaders = undefined) {
  const headers = new Headers(inputHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

async function readJson(request, maxBytes) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > maxBytes) throw new HttpError(413, "入力内容が大きすぎます。");
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); }
  return body && typeof body === "object" ? body : {};
}

function validMutationRequest(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== url.origin) return false;
  const contentType = request.headers.get("Content-Type") || "";
  return contentType.startsWith("application/json");
}

function isAllowedProtocol(url, env) {
  return url.protocol === "https:" || env.ALLOW_LOCAL_HTTP === "true";
}

function sameOrigin(request, url) {
  return request.headers.get("Origin") === url.origin;
}

function sessionCookie(token, policy, secure) {
  return sessionCookieValue(SESSION_COOKIE, token, BASE_PATH, policy, secure);
}

function clearSessionCookie(secure) {
  return `${SESSION_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function parseCookies(header) {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function normalizeAccountId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9-]{1,50}$/.test(id) ? id : "";
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? "" : value;
}

function validMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return "";
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12 ? value : "";
}

function normalizeInteger(value, min, max) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function normalizeText(value, maxLength, allowEmpty = false) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\r\n/g, "\n");
  if ((!allowEmpty && !text) || text.length > maxLength) return "";
  return text;
}

function currentJapanMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date());
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function requireOwner(session) {
  if (session.role !== "owner") throw new HttpError(403, "この操作を行う権限がありません。");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
