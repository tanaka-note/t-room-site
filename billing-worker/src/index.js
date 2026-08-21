import { monthBounds, signedDocumentAmount, summarizeSettlements } from "./finance.js";
import { LOGIN_LOCK_MINUTES, isLoginLocked } from "./login-limit.js";
import {
  ACCOUNT_LOGIN_LIMIT,
  createCurrentPasswordRecord,
  isSourceLocked,
  needsPasswordUpgrade,
  nextSourceAttempt,
  verifyPasswordRecord
} from "./auth-security.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import { enqueueSecurityAudit } from "../../assets/security-audit-worker.js";

const BASE_PATH = "/billing";
const SESSION_COOKIE = "troom_billing_session";
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const CURRENT_OWNER_LOGIN_ID = "contact@a-tanaka.jp";
const LEGACY_OWNER_LOGIN_ID = "sub@a-tanaka.jp";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SecurityIntegration extends WorkerEntrypoint {
  async describeAccount(input) {
    const account = await this.env.DB.prepare("SELECT id, display_name, role FROM billing_accounts WHERE id = ? AND is_active = 1")
      .bind(String(input?.accountId || "")).first();
    return account ? { valid: true, displayLabel: `請求書 ${account.display_name}（${account.role}）`, role: account.role } : { valid: false };
  }
}

export default {
  async fetch(request, env, context) {
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
        const response = await handleApi(request, env, url, path, context);
        return secureResponse(await refreshAuthenticatedSession(request, response, env, url, path));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return secureResponse(json({ error: "Method not allowed" }, 405));
      }
      return secureResponse(await serveAsset(request, env, url, path));
    } catch (error) {
      if (error instanceof HttpError) return secureResponse(json({ error: error.message }, error.status));
      console.error("Billing request failed", error instanceof Error ? error.message : "unknown error");
      return secureResponse(json({ error: "読み込みに失敗しました。時間を置いてもう一度お試しください。" }, 500));
    }
  }
};

async function handleApi(request, env, url, path, context) {
  if (path === "/api/session" && request.method === "GET") {
    const session = await readSession(request, env);
    return json({
      authenticated: Boolean(session),
      role: session?.role || null,
      accountId: session?.accountId || null,
      accountName: session?.accountName || null,
      authMethod: session?.authMethod || null
    });
  }

  if (path === "/api/login" && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    if (!env.SESSION_SECRET) throw new HttpError(503, "認証設定が完了していません。");
    const body = await readJson(request, 4096);
    const loginId = canonicalLoginId(body.loginId);
    const password = typeof body.password === "string" ? body.password : "";
    if (!loginId || !password || password.length > 256) {
      enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "password_login_failure", outcome: "failure", authMethod: "password" });
      throw new HttpError(400, "IDとパスワードを確認してください。");
    }

    const account = await env.DB.prepare(`
      SELECT id, login_id, display_name, role, password_salt, password_hash,
             password_iterations, password_pepper_version, session_version, is_active,
             failed_login_attempts, locked_until
      FROM billing_accounts WHERE login_id = ? COLLATE NOCASE LIMIT 1
    `).bind(loginId).first();
    const fingerprint = await loginFingerprint(request, loginId, env);
    const sourceAttempt = await env.DB.prepare(`
      SELECT failed_count, first_failed_at, locked_until
      FROM billing_login_attempts WHERE fingerprint = ?
    `).bind(fingerprint).first();
    if (isSourceLocked(sourceAttempt?.locked_until)) {
      await writeAudit(env, {
        eventType: "login_blocked",
        targetAccountId: account?.id || null,
        attemptedLoginId: loginId,
        details: { scope: "source" }
      });
      enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "login_blocked", outcome: "blocked", serviceAccountId: account?.id, role: account?.role, authMethod: "password" });
      throw loginRejected();
    }
    if (!account?.is_active) {
      await recordSourceLoginFailure(env, fingerprint, sourceAttempt);
      await writeAudit(env, { eventType: "login_failure", attemptedLoginId: loginId });
      enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "password_login_failure", outcome: "failure", authMethod: "password" });
      throw loginRejected();
    }
    if (isLoginLocked(account.locked_until)) {
      await writeAudit(env, {
        eventType: "login_blocked",
        targetAccountId: account.id,
        attemptedLoginId: loginId,
        details: { lockedUntil: account.locked_until }
      });
      enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "login_blocked", outcome: "blocked", serviceAccountId: account.id, role: account.role, authMethod: "password" });
      throw loginRejected();
    }

    const verified = Boolean(account.password_hash && account.password_salt)
      && await verifyPasswordRecord(password, account, env.BILLING_PASSWORD_PEPPER || "");
    if (!verified) {
      const nextSource = await recordSourceLoginFailure(env, fingerprint, sourceAttempt);
      await env.DB.prepare(`
        UPDATE billing_accounts SET
          failed_login_attempts = failed_login_attempts + 1,
          locked_until = CASE
            WHEN failed_login_attempts + 1 >= ? THEN datetime('now', ?)
            ELSE NULL
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(ACCOUNT_LOGIN_LIMIT, `+${LOGIN_LOCK_MINUTES} minutes`, account.id).run();
      const failedState = await env.DB.prepare(`
        SELECT failed_login_attempts, locked_until FROM billing_accounts WHERE id = ?
      `).bind(account.id).first();
      const accountLocked = isLoginLocked(failedState?.locked_until);
      const sourceLocked = isSourceLocked(nextSource.lockedUntil);
      await writeAudit(env, {
        eventType: accountLocked || sourceLocked ? "login_locked" : "login_failure",
        targetAccountId: account.id,
        attemptedLoginId: loginId,
        details: {
          accountFailedAttempts: Number(failedState?.failed_login_attempts || 0),
          sourceFailedAttempts: nextSource.failedCount,
          scope: accountLocked ? "account" : (sourceLocked ? "source" : null)
        }
      });
      enqueueSecurityAudit(env, context, request, { service: "billing", eventType: accountLocked || sourceLocked ? "login_locked" : "password_login_failure", outcome: accountLocked || sourceLocked ? "blocked" : "failure", serviceAccountId: account.id, role: account.role, authMethod: "password" });
      throw loginRejected();
    }

    await env.DB.prepare("DELETE FROM billing_login_attempts WHERE fingerprint = ?").bind(fingerprint).run();
    await env.DB.prepare(`
      UPDATE billing_accounts SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (failed_login_attempts != 0 OR locked_until IS NOT NULL)
    `).bind(account.id).run();
    try {
      await upgradePasswordAfterLogin(env, account, password);
    } catch (error) {
      // 認証済みの利用者を、補助的なハッシュ更新の失敗だけで締め出さないようにします。
      console.error("Billing password upgrade failed", error instanceof Error ? error.message : "unknown error");
    }
    await writeAudit(env, {
      eventType: "login_success",
      actorAccountId: account.id,
      targetAccountId: account.id,
      attemptedLoginId: loginId
    });

    const maxAge = sessionMaxAge(env);
    const token = await createSessionToken(account, maxAge, env, { authMethod: "password" });
    const headers = new Headers();
    headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
    enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "password_login_success", outcome: "success", serviceAccountId: account.id, role: account.role, authMethod: "password" });
    return json({ authenticated: true, role: account.role, accountId: account.id, accountName: account.display_name, authMethod: "password" }, 200, headers);
  }

  if (path === "/api/passkey/handoff" && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    if (String(env.PASSKEY_ENABLED || "true") !== "true" || !env.SECURITY) throw new HttpError(503, "パスキー機能は一時停止中です。ID・パスワードでログインしてください。");
    const body = await readJson(request, 4096);
    const handoff = await env.SECURITY.redeemHandoff(String(body.handoffToken || ""), "billing");
    if (!handoff) throw new HttpError(401, "パスキー認証の有効期限が切れています。もう一度お試しください。");
    const account = await env.DB.prepare("SELECT id, display_name, role, session_version, is_active FROM billing_accounts WHERE id = ?").bind(handoff.serviceAccountId).first();
    if (!account?.is_active) throw new HttpError(403, "請求書管理の連携先アカウントを確認できません。");
    const maxAge = sessionMaxAge(env);
    const token = await createSessionToken(account, maxAge, env, { identityId: handoff.identityId, authMethod: "passkey" });
    const headers = new Headers({ "Set-Cookie": sessionCookie(token, maxAge, url.protocol === "https:") });
    await writeAudit(env, { eventType: "passkey_login_success", actorAccountId: account.id, targetAccountId: account.id });
    enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "passkey_login_success", outcome: "success", identityId: handoff.identityId, serviceAccountId: account.id, role: account.role, authMethod: "passkey" });
    return json({ authenticated: true, role: account.role, accountId: account.id, accountName: account.display_name, authMethod: "passkey" }, 200, headers);
  }

  if (path === "/api/logout" && request.method === "POST") {
    if (!validMutationRequest(request, url)) throw new HttpError(403, "不正なリクエストです。");
    const session = await readSession(request, env);
    if (session) await writeAudit(env, { eventType: "logout", actorAccountId: session.accountId });
    const headers = new Headers();
    headers.set("Set-Cookie", clearSessionCookie(url.protocol === "https:"));
    return json({ ok: true }, 200, headers);
  }

  const session = await readSession(request, env);
  if (!session) throw new HttpError(401, "ログインが必要です。");
  if (request.method !== "GET" && !validMutationRequest(request, url)) {
    throw new HttpError(403, "不正なリクエストです。");
  }

  if (path === "/api/accounts" && request.method === "GET") return listAccounts(env, session);
  if (path === "/api/summary" && request.method === "GET") {
    const response = await getSummary(url, env, session);
    const targetAccountId = url.searchParams.get("accountId");
    if (session.role === "owner" && targetAccountId && targetAccountId !== session.accountId) {
      enqueueSecurityAudit(env, context, request, { service: "billing", eventType: "admin_access", outcome: "success", identityId: session.identityId, serviceAccountId: session.accountId, role: session.role, authMethod: session.authMethod, targetType: "billing_account", targetId: targetAccountId });
    }
    return response;
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
    return json({ accounts: [{ id: session.accountId, displayName: session.accountName, role: session.role }] });
  }
  const result = await env.DB.prepare(`
    SELECT id, display_name, role FROM billing_accounts
    WHERE is_active = 1 AND role = 'member'
    ORDER BY CASE id
      WHEN 'chiharu' THEN 1 WHEN 'hideaki' THEN 2 WHEN 'masami' THEN 3 WHEN 'yuuka' THEN 4
      WHEN 'machiko' THEN 5 ELSE 99 END
  `).all();
  return json({ accounts: (result.results || []).map((row) => ({ id: row.id, displayName: row.display_name, role: row.role })) });
}

async function getSummary(url, env, session) {
  const accountId = await resolveTargetAccount(url.searchParams.get("accountId"), env, session);
  const month = validMonth(url.searchParams.get("month")) || currentJapanMonth();
  const bounds = monthBounds(month);
  const account = await env.DB.prepare(`SELECT id, display_name FROM billing_accounts WHERE id = ? AND is_active = 1`).bind(accountId).first();
  if (!account) throw new HttpError(404, "利用者が見つかりません。");
  const entriesResult = await env.DB.prepare(`
    SELECT id, document_type, entry_date, category, amount_yen, description, note, created_at, updated_at
    FROM billing_entries
    WHERE account_id = ? AND deleted_at IS NULL AND category != 'income'
      AND entry_date >= ? AND entry_date < ?
    ORDER BY entry_date, id
  `).bind(accountId, bounds.start, bounds.next).all();
  const entries = (entriesResult.results || []).map(serializeEntry);

  const settlementsResult = await env.DB.prepare(`
    SELECT id, settlement_date, direction, method, amount_yen, note, created_at, updated_at
    FROM billing_settlements
    WHERE account_id = ? AND deleted_at IS NULL AND settlement_date >= ? AND settlement_date < ?
    ORDER BY settlement_date, id
  `).bind(accountId, bounds.start, bounds.next).all();
  const settlements = (settlementsResult.results || []).map(serializeSettlement);

  const beforeDocuments = await env.DB.prepare(`
    SELECT COALESCE(SUM(CASE document_type WHEN 'invoice' THEN amount_yen ELSE -amount_yen END), 0) AS total
    FROM billing_entries
    WHERE account_id = ? AND deleted_at IS NULL AND category != 'income' AND entry_date < ?
  `).bind(accountId, bounds.start).first();
  const throughMonthDocuments = await env.DB.prepare(`
    SELECT COALESCE(SUM(CASE document_type WHEN 'invoice' THEN amount_yen ELSE -amount_yen END), 0) AS total
    FROM billing_entries
    WHERE account_id = ? AND deleted_at IS NULL AND category != 'income' AND entry_date < ?
  `).bind(accountId, bounds.next).first();
  const beforeSettlements = await settlementBalanceBefore(env, accountId, bounds.start);
  const throughMonthSettlements = await settlementBalanceBefore(env, accountId, bounds.next);
  const settlementTotals = summarizeSettlements(settlements);
  return json({
    account: { id: account.id, displayName: account.display_name },
    month,
    openingBalanceYen: Number(beforeDocuments?.total || 0) + beforeSettlements,
    closingBalanceYen: Number(throughMonthDocuments?.total || 0) + throughMonthSettlements,
    entries,
    settlements,
    settlementTotals
  });
}

async function settlementBalanceBefore(env, accountId, beforeDate) {
  const result = await env.DB.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN method = 'offset' THEN 0
        WHEN direction = 'incoming' THEN -amount_yen
        ELSE amount_yen
      END
    ), 0) AS total
    FROM billing_settlements
    WHERE account_id = ? AND deleted_at IS NULL AND settlement_date < ?
  `).bind(accountId, beforeDate).first();
  return Number(result?.total || 0);
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
    ["/billing.css", "/billing.css"],
    ["/billing.js", "/billing.js"],
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
  if (!env.SESSION_SECRET) return null;
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!token) return null;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  const expected = await sign(encodedPayload, env.SESSION_SECRET);
  if (!constantTimeEqual(base64UrlToBytes(signature), base64UrlToBytes(expected))) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(encodedPayload)));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (String(payload.globalVersion) !== String(env.SESSION_VERSION || "1")) return null;
    const account = await env.DB.prepare(`
      SELECT id, display_name, role, session_version, is_active FROM billing_accounts WHERE id = ?
    `).bind(payload.accountId).first();
    if (!account?.is_active || account.role !== payload.role || Number(account.session_version) !== Number(payload.accountVersion)) return null;
    return { accountId: account.id, accountName: account.display_name, role: account.role, identityId: payload.identityId || null, authMethod: payload.authMethod || "password" };
  } catch {
    return null;
  }
}

async function createSessionToken(account, maxAge, env, auth = {}) {
  const payload = {
    accountId: account.id,
    role: account.role,
    accountVersion: Number(account.session_version),
    globalVersion: String(env.SESSION_VERSION || "1"),
    identityId: auth.identityId || null,
    authMethod: auth.authMethod || "password",
    exp: Math.floor(Date.now() / 1000) + maxAge
  };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(encoded, env.SESSION_SECRET)}`;
}

function sessionMaxAge(env) {
  return clampNumber(env.SESSION_TTL_SECONDS, 3600, MAX_SESSION_SECONDS, MAX_SESSION_SECONDS);
}

async function refreshAuthenticatedSession(request, response, env, url, path) {
  if (path === "/api/login" || path === "/api/passkey/handoff" || path === "/api/logout" || response.status === 401) return response;
  const session = await readSession(request, env);
  if (!session) return response;

  const account = await env.DB.prepare(`
    SELECT id, role, session_version FROM billing_accounts WHERE id = ? AND is_active = 1
  `).bind(session.accountId).first();
  if (!account) return response;

  const maxAge = sessionMaxAge(env);
  const token = await createSessionToken(account, maxAge, env, { identityId: session.identityId, authMethod: session.authMethod });
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", sessionCookie(token, maxAge, url.protocol === "https:"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function upgradePasswordAfterLogin(env, account, password) {
  if (!needsPasswordUpgrade(account) || !env.BILLING_PASSWORD_PEPPER) return false;
  const upgraded = await createCurrentPasswordRecord(password, env.BILLING_PASSWORD_PEPPER);
  const result = await env.DB.prepare(`
    UPDATE billing_accounts SET
      password_salt = ?, password_hash = ?, password_iterations = ?, password_pepper_version = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND password_pepper_version = ? AND password_iterations = ?
  `).bind(
    upgraded.passwordSalt,
    upgraded.passwordHash,
    upgraded.passwordIterations,
    upgraded.passwordPepperVersion,
    account.id,
    Number(account.password_pepper_version || 0),
    Number(account.password_iterations || 0)
  ).run();
  return Boolean(result.meta?.changes);
}

async function loginFingerprint(request, loginId, env) {
  const secret = env.LOGIN_FINGERPRINT_SECRET || env.SESSION_SECRET;
  if (!secret) throw new HttpError(503, "認証設定が完了していません。");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  return sign(`${ip}:${loginId}`, secret);
}

async function recordSourceLoginFailure(env, fingerprint, previous) {
  const next = nextSourceAttempt(previous);
  await env.DB.prepare(`
    INSERT INTO billing_login_attempts
      (fingerprint, failed_count, first_failed_at, locked_until, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(fingerprint) DO UPDATE SET
      failed_count = excluded.failed_count,
      first_failed_at = excluded.first_failed_at,
      locked_until = excluded.locked_until,
      updated_at = CURRENT_TIMESTAMP
  `).bind(fingerprint, next.failedCount, next.firstFailedAt, next.lockedUntil).run();
  return next;
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function resolveTargetAccount(requested, env, session) {
  if (session.role !== "owner") return session.accountId;
  let target = normalizeAccountId(requested);
  if (!target) {
    const first = await env.DB.prepare(`
      SELECT id FROM billing_accounts WHERE role = 'member' AND is_active = 1
      ORDER BY CASE id
        WHEN 'chiharu' THEN 1 WHEN 'hideaki' THEN 2 WHEN 'masami' THEN 3 WHEN 'yuuka' THEN 4
        WHEN 'machiko' THEN 5 ELSE 99 END
      LIMIT 1
    `).first();
    target = first?.id || "";
  }
  await assertTargetAccountExists(target, env);
  return target;
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

function loginRejected() {
  return new HttpError(401, "IDまたはパスワードが違うか、一時的にログインが停止されています。");
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

function sessionCookie(token, maxAge, secure) {
  return `${SESSION_COOKIE}=${token}; Path=${BASE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
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

function normalizeLoginId(value) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 120) : "";
}

function canonicalLoginId(value) {
  const normalized = normalizeLoginId(value);
  return normalized === LEGACY_OWNER_LOGIN_ID ? CURRENT_OWNER_LOGIN_ID : normalized;
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
