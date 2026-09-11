// Local, password-only policy. No cross-service/Identity fallback and no cache:
// every protected password request observes the current D1 generation.
export async function readPasswordAuthPolicy(env, service, accountId) {
  if (!["diary", "billing"].includes(service) || !accountId) throw new Error("InvalidPasswordPolicyAccount");
  const row = await env.DB.prepare(`SELECT password_auth_enabled, password_session_epoch
    FROM password_auth_policy WHERE service = ? AND account_id = ?`).bind(service, accountId).first();
  if (!row) return { enabled: true, epoch: 0 };
  if (![0, 1].includes(row.password_auth_enabled) || !Number.isSafeInteger(row.password_session_epoch) || row.password_session_epoch < 0) {
    throw new Error("InvalidPasswordPolicyState");
  }
  return { enabled: row.password_auth_enabled === 1, epoch: row.password_session_epoch };
}

export async function validatePasswordSession(payload, env, service) {
  if (payload.authMethod === "passkey") return true; // Still validated by the existing Passkey path.
  if (payload.authMethod != null && payload.authMethod !== "password") return false;
  const policy = await readPasswordAuthPolicy(env, service, payload.accountId);
  const epoch = payload.passwordSessionEpoch ?? 0; // Cookies issued before this feature.
  return policy.enabled && Number.isSafeInteger(epoch) && epoch === policy.epoch;
}

export function passwordSessionClaims(auth) {
  // Never adopt a newer DB epoch while refreshing an existing cookie. Carry the
  // epoch verified at login/readSession, so disable → enable races stay revoked.
  return auth.authMethod === "passkey" ? {} : { passwordSessionEpoch: auth.passwordSessionEpoch ?? 0 };
}
