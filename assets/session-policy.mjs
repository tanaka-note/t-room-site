export const PASSWORD_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const PASSKEY_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function sessionPolicyForAuthMethod(env, authMethod, passwordTtlSeconds = PASSWORD_SESSION_TTL_SECONDS) {
  if (authMethod === "passkey") {
    return {
      authMethod: "passkey",
      ttlSeconds: clampNumber(env?.PASSKEY_SESSION_TTL_SECONDS, 15 * 60, PASSKEY_SESSION_TTL_SECONDS, PASSKEY_SESSION_TTL_SECONDS),
      persistent: false,
      rolling: false
    };
  }
  return {
    authMethod: "password",
    ttlSeconds: clampNumber(passwordTtlSeconds, 60 * 60, PASSWORD_SESSION_TTL_SECONDS, PASSWORD_SESSION_TTL_SECONDS),
    persistent: true,
    rolling: true
  };
}

export function shouldRefreshSession(session) {
  return session?.authMethod === "password";
}

export function sessionCookieValue(name, token, path, policy, secure) {
  const maxAge = policy?.persistent ? `; Max-Age=${policy.ttlSeconds}` : "";
  return `${name}=${token}; Path=${path}${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function sessionExpiresAt(nowSeconds, policy, existingExpiresAt = null) {
  if (policy?.authMethod === "passkey" && existingExpiresAt != null && Number.isSafeInteger(Number(existingExpiresAt))) {
    return Number(existingExpiresAt);
  }
  return Number(nowSeconds) + Number(policy?.ttlSeconds || 0);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}
