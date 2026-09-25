import { isValidSessionSecret, requireSessionSecret } from "../../assets/session-secret.mjs";
import { lineBrowserResponse } from "../../assets/line-browser-worker.mjs";
import { sessionCookieValue, sessionPolicyForAuthMethod } from "../../assets/session-policy.mjs";
import { WorkerEntrypoint } from "cloudflare:workers";

const BASE_PATH = "/downloader2";
const SESSION_COOKIE = "troom_downloader2_session";
const SERVICE = "downloader2";
const SESSION_ROLE = "owner";
const PAIRING_TOKEN_BYTES = 32;
const PAIRING_TTL_SECONDS = 120;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default class Downloader2Worker extends WorkerEntrypoint {
  async fetch(request) {
    const blocked = lineBrowserResponse(request);
    if (blocked) return blocked;
    try {
      return await handleRequest(request, this.env, this.ctx);
    } catch (error) {
      const status = Number(error?.status || 500);
      if (status >= 500) console.error(JSON.stringify({ event: "downloader2_request_failed", error: safeErrorName(error) }));
      return json({ error: status >= 500 ? "Downloader 2で処理を完了できませんでした。" : error.message, code: error?.code || "request_failed" }, status);
    }
  }
}

export class SecurityIntegration extends WorkerEntrypoint {
  async getSessionRuntimeState() {
    return {
      sessionVersion: String(this.env.SESSION_VERSION || "1"),
      passkeyEnabled: String(this.env.PASSKEY_ENABLED || "false") === "true"
    };
  }

  async listLinkTargets() {
    return {
      service: SERVICE,
      displayName: "T-lain Downloader 2",
      targets: [{
        accountId: "owner",
        displayLabel: "T-lain Downloader 2 管理者",
        role: SESSION_ROLE,
        roleLabel: "管理者",
        privileged: true,
        exclusive: false,
        shared: false,
        rootFolderId: null
      }]
    };
  }

  async describeAccount(input) {
    return String(input?.accountId || "") === "owner"
      ? { valid: true, ...(await this.listLinkTargets()).targets[0] }
      : { valid: false };
  }
}

export async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(BASE_PATH)) throw new HttpError(404, "指定された情報が見つかりません。");
  const path = url.pathname.slice(BASE_PATH.length) || "/";
  if (!path.startsWith("/api/")) return serveAsset(request, env, url, path);
  requireSessionSecret(env.SESSION_SECRET, HttpError);

  if (path === "/api/passkey/handoff" && request.method === "POST") {
    requireMutation(request, url);
    return completePasskeyHandoff(request, env, url);
  }
  if (path === "/api/pairing/redeem" && request.method === "POST") {
    return redeemPairingChallenge(request, env);
  }

  const session = await requireSession(request, env);
  if (path === "/api/session" && request.method === "GET") {
    scheduleAudit(context, audit(env, request, session, "session_resume", "success"));
    return json({ authenticated: true, user: { displayName: displayName(session), role: SESSION_ROLE } });
  }
  if (path === "/api/logout" && request.method === "POST") {
    requireMutation(request, url);
    scheduleAudit(context, audit(env, request, session, "logout", "success"));
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(url.protocol === "https:") });
  }
  if (path === "/api/pairing/challenge" && request.method === "POST") {
    requireMutation(request, url);
    const body = await readJson(request, 4096);
    const deviceChallenge = String(body.deviceChallenge || "");
    if (!/^[A-Za-z0-9_-]{43}$/.test(deviceChallenge)) throw new HttpError(400, "Companionのペアリング要求を確認できませんでした。");
    const expiresAt = nowSeconds() + PAIRING_TTL_SECONDS;
    const token = await signPairingChallenge({ version: 1, nonce: randomToken(PAIRING_TOKEN_BYTES), deviceChallenge, expiresAt }, env);
    scheduleAudit(context, audit(env, request, session, "downloader2_pairing_started", "success"));
    return json({ version: 1, token, expiresAt });
  }
  throw new HttpError(404, "指定された情報が見つかりません。");
}

async function redeemPairingChallenge(request, env) {
  if (!String(request.headers.get("Content-Type") || "").startsWith("application/json")) throw new HttpError(415, "JSON形式で送信してください。");
  const body = await readJson(request, 8192);
  const deviceChallenge = String(body.deviceChallenge || "");
  const value = await verifyPairingChallenge(String(body.token || ""), env);
  if (!value || value.version !== 1 || value.deviceChallenge !== deviceChallenge || !/^[A-Za-z0-9_-]{43}$/.test(deviceChallenge) || Number(value.expiresAt) < nowSeconds()) {
    throw new HttpError(401, "ペアリングトークンが無効または期限切れです。", "pairing_invalid");
  }
  return json({ valid: true, expiresAt: Number(value.expiresAt) });
}

async function completePasskeyHandoff(request, env, url) {
  if (!env.SECURITY) throw new HttpError(503, "認証基盤へ接続できません。");
  if (!passkeysEnabled(env)) throw new HttpError(503, "パスキー機能は一時停止中です。");
  const body = await readJson(request, 4096);
  const handoff = await env.SECURITY.redeemHandoff(String(body.handoffToken || ""), SERVICE);
  if (!handoff || handoff.serviceAccountId !== "owner" || handoff.identityId !== "primary-admin") {
    throw new HttpError(401, "Downloader 2を利用できるパスキーを確認できませんでした。");
  }
  const policy = sessionPolicyForAuthMethod(env, "passkey");
  const payload = {
    identityId: handoff.identityId,
    displayName: handoff.identityDisplayName || "第一管理者",
    credentialId: handoff.credentialId,
    serviceLinkId: handoff.serviceLinkId,
    serviceAccountId: handoff.serviceAccountId,
    passkeySessionEpoch: handoff.sessionEpoch,
    authMethod: "passkey",
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    sessionVersion: String(env.SESSION_VERSION || "1"),
    expiresAt: nowSeconds() + policy.ttlSeconds
  };
  const token = await signSession(payload, env);
  await audit(env, request, payload, "passkey_login_success", "success");
  return json({ authenticated: true, displayName: displayName(payload) }, 200, {
    "Set-Cookie": sessionCookieValue(SESSION_COOKIE, token, BASE_PATH, policy, url.protocol === "https:")
  });
}

async function requireSession(request, env) {
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  const session = await verifySession(token, env);
  if (!session || !passkeysEnabled(env)) throw new HttpError(401, "パスキーでログインしてください。");
  const valid = await env.SECURITY?.validatePasskeySession({
    service: SERVICE,
    identityId: session.identityId,
    credentialId: session.credentialId,
    serviceLinkId: session.serviceLinkId,
    serviceAccountId: session.serviceAccountId,
    sessionEpoch: session.passkeySessionEpoch
  });
  if (valid?.valid !== true) throw new HttpError(401, "パスキーセッションの有効期限が切れました。もう一度ログインしてください。");
  return session;
}

function displayName(session) {
  return session.displayName || "第一管理者";
}

async function signSession(payload, env) {
  if (!isValidSessionSecret(env.SESSION_SECRET)) throw new HttpError(503, "Downloader 2のセッション設定が未完了です。");
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, env.SESSION_SECRET)}`;
}

async function signPairingChallenge(payload, env) {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(`pairing:${encoded}`, env.SESSION_SECRET)}`;
}

async function verifyPairingChallenge(token, env) {
  const [payload, signature, extra] = String(token || "").split(".");
  if (!payload || !signature || extra || !(await safeEqual(signature, await hmac(`pairing:${payload}`, env.SESSION_SECRET)))) return null;
  try { return JSON.parse(decoder.decode(base64UrlToBytes(payload))); } catch { return null; }
}

async function verifySession(token, env) {
  if (!token || !isValidSessionSecret(env.SESSION_SECRET)) return null;
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra || !(await safeEqual(signature, await hmac(payload, env.SESSION_SECRET)))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return value.authMethod === "passkey" && value.identityId === "primary-admin" && value.serviceAccountId === "owner" &&
      Number(value.expiresAt) > nowSeconds() && String(value.sessionVersion) === String(env.SESSION_VERSION || "1") ? value : null;
  } catch { return null; }
}

async function audit(env, request, session, eventType, outcome, details = {}) {
  try {
    await env.SECURITY?.recordAuditEvent({
      service: SERVICE, eventType, outcome, identityId: session.identityId,
      serviceLinkId: session.serviceLinkId, serviceAccountId: session.serviceAccountId,
      role: SESSION_ROLE, authMethod: "passkey", credentialId: session.credentialId,
      expiresAt: session.expiresAt, startedAt: session.startedAt, sessionVersion: session.sessionVersion,
      passkeySessionEpoch: session.passkeySessionEpoch,
      sessionIdHash: session.sessionId ? await hmac(session.sessionId, env.SESSION_SECRET || SERVICE) : null,
      userAgent: request.headers.get("User-Agent"), details
    });
  } catch { /* Authentication does not depend on audit transport. */ }
}

async function serveAsset(request, env, url, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path === "/" ? "/" : path, url.origin), request));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", path === "/" ? "no-store" : "no-cache");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireMutation(request, url) {
  if (request.headers.get("Origin") !== url.origin || !String(request.headers.get("Content-Type") || "").startsWith("application/json")) {
    throw new HttpError(403, "不正なリクエストです。");
  }
}

function passkeysEnabled(env) { return String(env.PASSKEY_ENABLED || "false") === "true"; }
function clearCookie(secure) { return `${SESSION_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
function parseCookies(header) { return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)]; })); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function scheduleAudit(context, promise) { if (context?.waitUntil) context.waitUntil(promise); else void promise.catch(() => {}); }
function randomToken(size) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytesToBase64Url(bytes); }
function safeErrorName(error) { return error instanceof Error ? `${String(error.name || "Error").slice(0, 60)}:${String(error.code || "unspecified").slice(0, 60)}` : "unknown"; }
function json(value, status = 200, inputHeaders) { const headers = new Headers(inputHeaders); headers.set("Content-Type", "application/json; charset=utf-8"); headers.set("Cache-Control", "no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("X-Robots-Tag", "noindex, nofollow, noarchive"); return new Response(JSON.stringify(value), { status, headers }); }
async function readJson(request, max) { const size = Number(request.headers.get("Content-Length") || 0); if (size > max) throw new HttpError(413, "入力内容が大きすぎます。"); try { const value = await request.json(); return value && typeof value === "object" ? value : {}; } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); } }
async function hmac(value, secret) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
async function safeEqual(left, right) { let a; let b; try { a = base64UrlToBytes(left); b = base64UrlToBytes(right); } catch { return false; } if (a.length !== b.length) return false; let result = 0; for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index]; return result === 0; }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlToBytes(value) { const text = String(value || ""); if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error("invalid base64url"); const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}
