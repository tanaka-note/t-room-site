// Local service-boundary fixture. SQL/revocation behavior is tested separately
// against the production Security Worker and its complete SQLite schema.
export function rollingBinding(validate = () => true) {
  const sessions = new Map();
  return async input => {
    const now = Math.floor(Date.now() / 1000);
    const key = input.sessionIdHash;
    if (input.action === "register" && !sessions.has(key)) sessions.set(key, { ...input, ended: false });
    const row = sessions.get(key);
    if (!row || ["service", "identityId", "credentialId", "serviceLinkId", "serviceAccountId", "role", "sessionVersion", "sessionEpoch"].some(k => row[k] !== input[k])) return { valid: false };
    if (input.action === "end") { row.ended = true; return { valid: true }; }
    if (row.ended || row.expiresAt <= now || !await validate(input)) return { valid: false };
    if (input.action === "touch") row.expiresAt = Math.max(row.expiresAt, now + 43200);
    return { valid: true, expiresAt: row.expiresAt };
  };
}
