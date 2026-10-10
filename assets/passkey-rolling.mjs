import { PASSKEY_SESSION_TTL_SECONDS } from "./session-policy.mjs";

// This claim opts in only newly authenticated sessions. Legacy cookies keep
// their original expiry and require a fresh passkey before they can roll.
export const ROLLING_SESSION_VERSION = 1;

export function foregroundSessionActivity(request, response, path) {
  return response.ok && request.headers.get("X-Troom-Activity") === "foreground"
    && path.startsWith("/api/")
    && !/^\/api\/(session|status|logout|login|password-login-audit|passkey|auth|app-version|setup|bootstrap|invite|tcloud)(\/|$)/.test(path)
    && path !== "/api/pairing/redeem";
}

export async function rollingSessionInput(env, service, session, action) {
  const role = service === "security" ? (session.kind === "admin" ? "security-admin" : "identity")
    : service === "ai" ? (session.identityId === "primary-admin" ? "admin" : "user")
    : service.startsWith("downloader") ? "owner"
    : service === "diary" ? session.auditRole || session.role : session.role;
  const sessionVersion = service === "security" ? "security-1"
    : ["diary", "billing"].includes(service)
      ? `${env.SESSION_VERSION || "1"}:${Number(session.accountVersion || 1)}`
      : String(session.sessionVersion || env.SESSION_VERSION || "1");
  // Match each service's existing audit pseudonym; raw IDs/tokens stay local.
  const salt = ["security", "diary", "billing"].includes(service)
    ? env.AUDIT_IP_SALT || env.SESSION_SECRET : env.SESSION_SECRET;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session.sessionId)));
  const sessionIdHash = btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { service, action, sessionIdHash, identityId: session.identityId, credentialId: session.credentialId,
    serviceLinkId: session.serviceLinkId || null,
    serviceAccountId: service === "security" ? role : session.serviceAccountId,
    sessionEpoch: session.passkeySessionEpoch, role, sessionVersion,
    startedAt: session.startedAt || new Date(session.authenticatedAt * 1000).toISOString(),
    expiresAt: session.exp ?? session.expiresAt, ttlSeconds: PASSKEY_SESSION_TTL_SECONDS };
}

export async function serviceRollingSession(env, service, session, action) {
  if (session?.authMethod !== "passkey" || session.rollingSessionVersion == null) return { valid: true, legacy: true };
  if (session.rollingSessionVersion !== ROLLING_SESSION_VERSION || !session.sessionId) return { valid: false };
  try { return await env.SECURITY.passkeyRollingSession(await rollingSessionInput(env, service, session, action)); }
  catch { return { valid: false }; }
}

export async function renewServiceSession(request, response, env, service, path, session, cookie) {
  if (!session || session.rollingSessionVersion !== ROLLING_SESSION_VERSION || !foregroundSessionActivity(request, response, path)) return response;
  const renewed = await serviceRollingSession(env, service, session, "touch");
  if (!renewed.valid) return new Response(JSON.stringify({ error: "パスキーでログインし直してください。" }), { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", await cookie(renewed.expiresAt));
  headers.set("X-Troom-Session-Expires", String(renewed.expiresAt));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
