// A disabled Identity is an audit attribution record until every guard passes.
// Only Security DB metadata is touched; never call a service or an R2 binding.
const KNOWN_TABLES = new Set([
  "security_identities", "security_credentials", "security_service_links",
  "security_invitations", "security_setup_sessions", "security_challenges",
  "security_handoffs", "security_tcloud_client_vaults", "security_tcloud_key_envelopes",
  "security_active_sessions", "security_audit_events", "security_ai_budget_policies",
  "security_runtime_state", "security_definition_events", "security_definition_updates"
]);

export const DISABLED_IDENTITY_CLEANUP_LIMIT = 20;

// Reused for candidate selection AND each mutation to close the read/delete race.
// Unknown states and even expired setup/challenge/handoff rows block deletion;
// their existing scheduled expiry cleanup must finish first.
export const DISABLED_IDENTITY_CLEANUP_GUARD = `
  identity.status = 'disabled' AND identity.id != 'primary-admin' AND identity.is_security_admin = 0
  AND datetime(identity.updated_at) < datetime(?1)
  AND (identity.last_login_at IS NULL OR datetime(identity.last_login_at) < datetime(?1))
  AND (identity.last_seen_at IS NULL OR datetime(identity.last_seen_at) < datetime(?1))
  AND NOT EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id = identity.id AND c.status != 'revoked')
  AND NOT EXISTS (SELECT 1 FROM security_service_links l WHERE l.identity_id = identity.id
    AND (l.status != 'disabled' OR l.service IN ('ai', 'downloader')))
  AND NOT EXISTS (SELECT 1 FROM security_invitations v WHERE v.identity_id = identity.id AND v.status NOT IN ('used', 'revoked', 'expired'))
  AND NOT EXISTS (SELECT 1 FROM security_invitations v WHERE v.created_by_identity_id = identity.id)
  AND NOT EXISTS (SELECT 1 FROM security_ai_budget_policies p WHERE p.identity_id = identity.id)
  AND NOT EXISTS (SELECT 1 FROM security_setup_sessions s WHERE s.identity_id = identity.id
    OR s.credential_id IN (SELECT credential_id FROM security_credentials WHERE identity_id = identity.id))
  AND NOT EXISTS (SELECT 1 FROM security_challenges c WHERE c.identity_id = identity.id
    OR c.invitation_id IN (SELECT id FROM security_invitations WHERE identity_id = identity.id))
  AND NOT EXISTS (SELECT 1 FROM security_handoffs h WHERE h.identity_id = identity.id
    OR h.credential_id IN (SELECT credential_id FROM security_credentials WHERE identity_id = identity.id)
    OR h.service_link_id IN (SELECT id FROM security_service_links WHERE identity_id = identity.id))
  AND NOT EXISTS (SELECT 1 FROM security_tcloud_client_vaults v WHERE v.identity_id = identity.id
    OR v.credential_id IN (SELECT credential_id FROM security_credentials WHERE identity_id = identity.id))
  AND NOT EXISTS (SELECT 1 FROM security_tcloud_key_envelopes e WHERE e.identity_id = identity.id
    OR e.credential_id IN (SELECT credential_id FROM security_credentials WHERE identity_id = identity.id)
    OR e.service_link_id IN (SELECT id FROM security_service_links WHERE identity_id = identity.id))
  AND NOT EXISTS (SELECT 1 FROM security_credentials c WHERE c.identity_id != identity.id
    AND c.registered_via_invitation_id IN (SELECT id FROM security_invitations WHERE identity_id = identity.id))
  AND NOT EXISTS (SELECT 1 FROM security_active_sessions s WHERE
    (s.identity_id = identity.id
      OR s.credential_id IN (SELECT credential_id FROM security_credentials WHERE identity_id = identity.id)
      OR s.service_link_id IN (SELECT id FROM security_service_links WHERE identity_id = identity.id))
    AND (s.identity_id IS NULL OR s.identity_id != identity.id OR s.ended_at IS NULL
      OR COALESCE((datetime(s.ended_at) < datetime(?1) AND datetime(s.last_seen_at) < datetime(?1)
        AND s.expires_at < unixepoch(?1)), 0) = 0))
  AND NOT EXISTS (SELECT 1 FROM security_audit_events a WHERE a.identity_id = identity.id
    OR a.target_id = identity.id OR instr(a.details_json, identity.id) > 0
    OR a.service_link_id IN (SELECT id FROM security_service_links WHERE identity_id = identity.id)
    OR a.target_id IN (SELECT id FROM security_service_links WHERE identity_id = identity.id)
    OR a.target_id IN (SELECT credential_id FROM security_credentials WHERE identity_id = identity.id)
    OR a.target_id IN (SELECT id FROM security_invitations WHERE identity_id = identity.id))
`;

export async function cleanupDisabledIdentities(db, retentionCutoff) {
  if (!Number.isFinite(Date.parse(retentionCutoff))) throw new Error("Invalid Identity retention cutoff");
  // New tables/triggers require a new dependency review before enabling deletion.
  const schema = await db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'").all();
  if ((schema.results || []).some((row) => row.type !== "table" || !KNOWN_TABLES.has(row.name))
    || [...KNOWN_TABLES].some((name) => !(schema.results || []).some((row) => row.name === name))) {
    console.warn("Identity cleanup skipped: schema requires dependency review");
    return { deleted: 0, skipped: "schema" };
  }
  const candidates = await db.prepare(`SELECT identity.id FROM security_identities identity
    WHERE ${DISABLED_IDENTITY_CLEANUP_GUARD} ORDER BY identity.updated_at, identity.id LIMIT ${DISABLED_IDENTITY_CLEANUP_LIMIT}`)
    .bind(retentionCutoff).all();
  let deleted = 0;
  for (const { id } of candidates.results || []) {
    // D1 batch is one transaction. Re-check before both deletes; FK errors roll
    // back the session cleanup too. The parent cascade only removes reviewed,
    // revoked/disabled metadata. Crypto presence always blocks the whole batch.
    const result = await db.batch([
      db.prepare(`DELETE FROM security_active_sessions WHERE identity_id = ?2
        AND EXISTS (SELECT 1 FROM security_identities identity WHERE identity.id = ?2 AND ${DISABLED_IDENTITY_CLEANUP_GUARD})`)
        .bind(retentionCutoff, id),
      db.prepare(`DELETE FROM security_identities AS identity WHERE identity.id = ?2 AND ${DISABLED_IDENTITY_CLEANUP_GUARD}`)
        .bind(retentionCutoff, id),
      db.prepare(`INSERT INTO security_audit_events (event_id, occurred_at, service, event_type, outcome, auth_method, details_json)
        SELECT ?, ?, 'security', 'disabled_identity_cleanup', 'info', 'system', ? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), new Date().toISOString(), JSON.stringify({ deletedCount: 1, retentionCutoff, policyVersion: 1 }))
    ]);
    deleted += Number(result[1]?.meta?.changes || 0);
  }
  return { deleted };
}
