export const PASSWORD_SESSION_TTL_SECONDS = 12 * 60 * 60;
// Password-only generation: old rolling cookies cannot survive this rollout.
export const PASSWORD_SESSION_VERSION = 1;
export const PASSKEY_SESSION_TTL_SECONDS = 12 * 60 * 60;

// Kept as an alias for Cloud callers. Every passkey uses the same policy.
export function cloudSessionPolicyForAuthMethod(env, authMethod, passwordTtlSeconds) {
  return sessionPolicyForAuthMethod(env, authMethod, passwordTtlSeconds);
}

export function sessionPolicyForAuthMethod(env, authMethod, passwordTtlSeconds = PASSWORD_SESSION_TTL_SECONDS) {
  if (authMethod === "passkey") {
    return {
      authMethod: "passkey",
      ttlSeconds: PASSKEY_SESSION_TTL_SECONDS,
      persistent: true,
      rolling: true
    };
  }
  return {
    authMethod: "password",
    ttlSeconds: clampNumber(passwordTtlSeconds, 60 * 60, PASSWORD_SESSION_TTL_SECONDS, PASSWORD_SESSION_TTL_SECONDS),
    persistent: false,
    rolling: false
  };
}

export function shouldRefreshSession(session) {
  return Boolean(session && sessionPolicyForAuthMethod({}, session.authMethod).rolling);
}

export function passwordLifetimeClaims(session) {
  return session.authMethod === "passkey" ? {} : { passwordSessionVersion: PASSWORD_SESSION_VERSION };
}

export function validSessionLifetime(session, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(session?.exp) || session.exp <= nowSeconds) return false;
  if (session.authMethod === "passkey") return true;
  if (session.authMethod != null && session.authMethod !== "password") return false;
  const startedAt = Math.floor(Date.parse(session.startedAt) / 1000);
  return session.passwordSessionVersion === PASSWORD_SESSION_VERSION && Number.isSafeInteger(startedAt)
    && startedAt <= nowSeconds && session.exp > startedAt
    && session.exp <= startedAt + PASSWORD_SESSION_TTL_SECONDS;
}

export function sessionCookieValue(name, token, path, policy, secure) {
  const maxAge = policy?.persistent ? `; Max-Age=${policy.ttlSeconds}` : "";
  return `${name}=${token}; Path=${path}${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function sessionExpiresAt(nowSeconds, policy, existingExpiresAt = null) {
  if (existingExpiresAt != null && Number.isSafeInteger(Number(existingExpiresAt))) {
    return Number(existingExpiresAt);
  }
  return Number(nowSeconds) + Number(policy?.ttlSeconds || 0);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
