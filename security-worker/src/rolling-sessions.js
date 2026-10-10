import { PASSKEY_SESSION_TTL_SECONDS } from "../../assets/session-policy.mjs";

// Internal service binding only. Authority remains the service's signed cookie
// plus its live Identity/link/account checks; this stores expiry and revocation.
export async function trackedPasskeySession(env, input, validate) {
  const now = Math.floor(Date.now() / 1000);
  if (!["security", "diary", "billing", "ai", "downloader", "downloader2"].includes(input?.service)
    || !/^[A-Za-z0-9_-]{43}$/.test(input.sessionIdHash || "")
    || !["register", "read", "touch", "end"].includes(input.action)
    || !input.identityId || !input.credentialId || !input.role || !input.serviceAccountId || !input.sessionVersion
    || !Number.isSafeInteger(input.sessionEpoch) || input.sessionEpoch < 1) return { valid: false };
  if (input.action !== "end" && !await validate(input)) return { valid: false };
  if (input.action === "register") {
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + PASSKEY_SESSION_TTL_SECONDS
      || !Number.isFinite(Date.parse(input.startedAt)) || Date.parse(input.startedAt) > Date.now()) return { valid: false };
    await env.DB.prepare(`INSERT INTO security_active_sessions
      (session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id,
       role, auth_method, session_version, passkey_session_epoch, started_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'passkey', ?, ?, ?, ?, ?) ON CONFLICT(session_id_hash) DO NOTHING`)
      .bind(input.sessionIdHash, input.identityId, input.service, input.serviceLinkId || null, input.serviceAccountId,
        input.credentialId, input.role, input.sessionVersion, input.sessionEpoch, input.startedAt, new Date().toISOString(), input.expiresAt).run();
  }
  const row = await env.DB.prepare("SELECT * FROM security_active_sessions WHERE session_id_hash = ?").bind(input.sessionIdHash).first();
  if (!row) return { valid: input.action === "end" };
  if (row.service !== input.service || row.identity_id !== input.identityId || row.credential_id !== input.credentialId
    || (row.service_link_id || null) !== (input.serviceLinkId || null) || row.service_account_id !== input.serviceAccountId
    || row.role !== input.role || row.auth_method !== "passkey" || row.session_version !== input.sessionVersion
    || Number(row.passkey_session_epoch) !== input.sessionEpoch) return { valid: false };
  if (input.action === "end") {
    await env.DB.prepare("UPDATE security_active_sessions SET ended_at = ?, end_reason = 'logout', updated_at = CURRENT_TIMESTAMP WHERE session_id_hash = ? AND ended_at IS NULL")
      .bind(new Date().toISOString(), input.sessionIdHash).run();
    return { valid: true };
  }
  if (row.ended_at || Number(row.expires_at) <= now) return { valid: false };
  if (input.action === "touch") {
    if (input.ttlSeconds !== PASSKEY_SESSION_TTL_SECONDS) return { valid: false };
    const result = await env.DB.prepare(`UPDATE security_active_sessions SET expires_at = MAX(expires_at, ?), last_seen_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id_hash = ? AND ended_at IS NULL AND expires_at > ?`)
      .bind(now + PASSKEY_SESSION_TTL_SECONDS, new Date().toISOString(), input.sessionIdHash, now).run();
    if (!result.meta?.changes) return { valid: false };
    return { valid: true, expiresAt: Math.max(Number(row.expires_at), now + PASSKEY_SESSION_TTL_SECONDS) };
  }
  return { valid: true, expiresAt: Number(row.expires_at) };
}
