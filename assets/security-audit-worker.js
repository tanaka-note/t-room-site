import { isValidSessionSecret } from "./session-secret.mjs";

const encoder = new TextEncoder();
const passwordFailures = new WeakSet();
const correlationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function correlationId(request) {
  const value = request.headers.get("X-Login-Correlation-ID") || "";
  return correlationPattern.test(value) ? value.toLowerCase() : null;
}

// Observe malformed requests/configuration errors as well as explicit decisions.
// Audit delivery never changes the response or authentication state.
export async function withPasswordLoginAudit(env, request, service, operation) {
  // Preserve the existing configuration guard: invalid signing configuration
  // must stop the API before any other binding is accessed.
  if (!isValidSessionSecret(env.SESSION_SECRET)) return operation();
  const isLogin = request.method === "POST" && new URL(request.url).pathname.endsWith("/api/login");
  try {
    const response = await operation();
    if (isLogin && response.status >= 400 && !passwordFailures.has(request)) {
      await recordSecurityAudit(env, request, { service, eventType: "password_login_failure", outcome: "failure", authMethod: "password",
        details: { stage: "request_validation", reason: response.status === 429 ? "rate_limited" : "invalid_request", counterUpdated: false } });
    }
    return response;
  } catch (error) {
    if (isLogin && !passwordFailures.has(request)) {
      const status = Number(error?.status || 500);
      await recordSecurityAudit(env, request, { service, eventType: "password_login_failure", outcome: "failure", authMethod: "password",
        details: { stage: status >= 500 ? "authentication" : "request_validation", reason: status >= 500 ? "authentication_error" : status === 429 ? "rate_limited" : "invalid_request", counterUpdated: status >= 500 ? null : false } });
    }
    throw error;
  }
}

const clientReasons = Object.freeze({
  form_submit: ["submitted"],
  form_validation: ["login_id_invalid", "password_length_invalid", "input_invalid", "unexpected_client_error"],
  auth_mode: ["request_failed", "network_error", "unexpected_client_error"],
  credential_derivation: ["password_length_invalid", "login_id_invalid", "crypto_unavailable", "credential_derivation_failed"],
  login_request: ["network_error", "unexpected_client_error"],
  login_response: ["request_failed", "unexpected_client_error"]
});

// Public telemetry is an untrusted client report, never proof of authentication.
// No ID, credential, free text, exception, session or form body is accepted.
export async function handlePasswordLoginClientAudit(env, request, service) {
  const headers = { "Cache-Control": "no-store" };
  const reply = status => new Response(null, { status, headers });
  if (request.headers.get("Origin") !== new URL(request.url).origin
    || !(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return reply(403);
  if (!env.PASSWORD_AUDIT_RATE_LIMITER?.limit) return reply(503);
  try {
    const { success } = await env.PASSWORD_AUDIT_RATE_LIMITER.limit({ key: await hmac(request.headers.get("CF-Connecting-IP") || "local", env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit") });
    if (!success) return reply(429);
  } catch { return reply(503); }
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply(400);
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return reply(413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return reply(400); }
  const allowed = ["eventType", "stage", "reason", "requestCorrelationId", "buildId", "isPwa"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))
    || !correlationPattern.test(body.requestCorrelationId || "") || typeof body.isPwa !== "boolean"
    || (body.buildId !== undefined && !new RegExp(`^${service}-[a-f0-9]{12}$`).test(body.buildId))
    || !Object.hasOwn(clientReasons, body.stage) || !clientReasons[body.stage].includes(body.reason)
    || body.eventType !== (body.stage === "form_submit" ? "password_login_submit" : "password_login_client_failure")) return reply(400);
  const result = await recordSecurityAudit(env, request, { service, eventType: body.eventType,
    outcome: body.stage === "form_submit" ? "info" : "failure", authMethod: "password",
    eventId: await hmac(`${service}|${body.requestCorrelationId.toLowerCase()}|${body.stage}|${body.reason}`, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit"),
    details: { stage: body.stage, reason: body.reason, reportedBy: "client", service,
      requestCorrelationId: body.requestCorrelationId.toLowerCase(), buildId: body.buildId, isPwa: body.isPwa, counterUpdated: false } });
  return reply(result.delivered ? 204 : 503);
}

export function enqueueSecurityAudit(env, context, request, input) {
  if (!env.SECURITY_AUDIT?.send || !context?.waitUntil) return;
  const task = buildSecurityAuditEvent(request, input, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit")
    .then((event) => env.SECURITY_AUDIT.send(event))
    .catch((error) => console.error("Security audit enqueue failed", error instanceof Error ? error.name : "unknown"));
  context.waitUntil(task);
}

export async function recordSecurityAudit(env, request, input) {
  if (input.authMethod === "password" && ["password_login_failure", "login_blocked", "login_locked"].includes(input.eventType)) passwordFailures.add(request);
  let event;
  try {
    event = await buildSecurityAuditEvent(request, input, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit");
  } catch (error) {
    auditDeliveryError(input, request, "event_build_failed");
    return { delivered: false, mode: "none", eventId: null };
  }

  try {
    if (typeof env.SECURITY?.recordAuditEvent !== "function") throw new Error("SecurityAuditBindingUnavailable");
    const acknowledgement = await env.SECURITY.recordAuditEvent(event);
    if (acknowledgement?.stored === false) throw new Error("SecurityAuditNotStored");
    return { delivered: true, mode: "synchronous", eventId: event.eventId };
  } catch (error) {
    auditDeliveryError(input, request, "sync_failed", event.eventId);
  }

  try {
    if (typeof env.SECURITY_AUDIT?.send !== "function") throw new Error("SecurityAuditQueueUnavailable");
    await env.SECURITY_AUDIT.send(event);
    return { delivered: true, mode: "queue", eventId: event.eventId };
  } catch (error) {
    auditDeliveryError(input, request, "delivery_failed", event.eventId);
    return { delivered: false, mode: "none", eventId: event.eventId };
  }
}

function auditDeliveryError(input, request, reason, eventId = null) {
  console.error("Security audit delivery", { service: input.service, eventType: input.eventType, reason, eventId,
    requestCorrelationId: correlationId(request) || (correlationPattern.test(input.details?.requestCorrelationId || "") ? input.details.requestCorrelationId : null) });
}

export async function buildSecurityAuditEvent(request, input, auditSalt = "local-audit") {
  const ip = request?.headers?.get("CF-Connecting-IP") || "local";
  return {
    eventId: input.eventId || crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    service: input.service,
    eventType: input.eventType,
    outcome: input.outcome,
    identityId: input.identityId || null,
    serviceLinkId: input.serviceLinkId || null,
    serviceAccountId: input.serviceAccountId || null,
    role: input.role || null,
    authMethod: input.authMethod || null,
    credentialId: input.credentialId || null,
    expiresAt: Number.isSafeInteger(Number(input.expiresAt)) ? Number(input.expiresAt) : null,
    startedAt: input.startedAt ?? null,
    sessionVersion: input.sessionVersion == null ? null : String(input.sessionVersion).slice(0, 80),
    passkeySessionEpoch: Number.isSafeInteger(Number(input.passkeySessionEpoch)) ? Number(input.passkeySessionEpoch) : null,
    sessionIdHash: input.sessionId ? await hmac(input.sessionId, auditSalt) : null,
    sourceHash: await hmac(ip, auditSalt),
    userAgent: String(request?.headers?.get("User-Agent") || "").slice(0, 300) || null,
    targetType: input.targetType || null,
    targetId: input.targetId == null ? null : String(input.targetId).slice(0, 160),
    details: sanitizeDetails({ ...input.details, ...(input.authMethod === "password" && correlationId(request) ? { requestCorrelationId: correlationId(request) } : {}) })
  };
}

function sanitizeDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const forbidden = /password|secret|token|cookie|proof|key|content|title|body|recovery|credential.?master|prf.?output|login.?id/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !forbidden.test(key))
    .slice(0, 20)
    .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 200) : (typeof item === "number" || typeof item === "boolean" ? item : null)]));
}

async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value || ""))));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(String(value || ""))));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
