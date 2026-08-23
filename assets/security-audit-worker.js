const encoder = new TextEncoder();

export function enqueueSecurityAudit(env, context, request, input) {
  if (!env.SECURITY_AUDIT?.send || !context?.waitUntil) return;
  const task = buildSecurityAuditEvent(request, input, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit")
    .then((event) => env.SECURITY_AUDIT.send(event))
    .catch((error) => console.error("Security audit enqueue failed", error instanceof Error ? error.name : "unknown"));
  context.waitUntil(task);
}

export async function recordSecurityAudit(env, request, input) {
  let event;
  try {
    event = await buildSecurityAuditEvent(request, input, env.AUDIT_IP_SALT || env.SESSION_SECRET || "local-audit");
  } catch (error) {
    console.error("Security audit event build failed", error instanceof Error ? error.name : "unknown");
    return { delivered: false, mode: "none", eventId: null };
  }

  try {
    if (typeof env.SECURITY?.recordAuditEvent !== "function") throw new Error("SecurityAuditBindingUnavailable");
    await env.SECURITY.recordAuditEvent(event);
    return { delivered: true, mode: "synchronous", eventId: event.eventId };
  } catch (error) {
    console.error("Security audit synchronous delivery failed", error instanceof Error ? error.name : "unknown");
  }

  try {
    if (typeof env.SECURITY_AUDIT?.send !== "function") throw new Error("SecurityAuditQueueUnavailable");
    await env.SECURITY_AUDIT.send(event);
    return { delivered: true, mode: "queue", eventId: event.eventId };
  } catch (error) {
    console.error("Security audit fallback enqueue failed", error instanceof Error ? error.name : "unknown");
    return { delivered: false, mode: "none", eventId: event.eventId };
  }
}

export async function buildSecurityAuditEvent(request, input, auditSalt = "local-audit") {
  const ip = request?.headers?.get("CF-Connecting-IP") || "local";
  return {
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    service: input.service,
    eventType: input.eventType,
    outcome: input.outcome,
    identityId: input.identityId || null,
    serviceLinkId: input.serviceLinkId || null,
    serviceAccountId: input.serviceAccountId || null,
    role: input.role || null,
    authMethod: input.authMethod || null,
    sessionIdHash: input.sessionId ? await hmac(input.sessionId, auditSalt) : null,
    sourceHash: await hmac(ip, auditSalt),
    userAgent: String(request?.headers?.get("User-Agent") || "").slice(0, 300) || null,
    targetType: input.targetType || null,
    targetId: input.targetId == null ? null : String(input.targetId).slice(0, 160),
    details: sanitizeDetails(input.details)
  };
}

function sanitizeDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const forbidden = /password|secret|token|cookie|proof|key|content|title|body|recovery/i;
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
