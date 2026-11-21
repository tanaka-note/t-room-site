-- Run against security-db after deleting the Household account. Invitations
-- bind the exact link set, so affected identities need a fresh invitation.
UPDATE security_invitations
SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
WHERE status = 'active' AND identity_id IN (
  SELECT identity_id FROM security_service_links
  WHERE service = 'household' AND service_account_id = 'chiharu-admin'
);

UPDATE security_active_sessions
SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    end_reason = 'service_link_disabled', updated_at = CURRENT_TIMESTAMP
WHERE ended_at IS NULL AND service = 'household' AND (
  service_account_id = 'chiharu-admin' OR service_link_id IN (
    SELECT id FROM security_service_links
    WHERE service = 'household' AND service_account_id = 'chiharu-admin'
  )
);

DELETE FROM security_handoffs
WHERE service_link_id IN (
  SELECT id FROM security_service_links
  WHERE service = 'household' AND service_account_id = 'chiharu-admin'
);

INSERT INTO security_audit_events (
  event_id, occurred_at, service, event_type, outcome, identity_id,
  service_account_id, service_link_id, auth_method, details_json
)
SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       service, 'service_link_removed', 'success', identity_id,
       service_account_id, id, 'system', '{"source":"household_account_retirement"}'
FROM security_service_links
WHERE service = 'household' AND service_account_id = 'chiharu-admin';

DELETE FROM security_service_links
WHERE service = 'household' AND service_account_id = 'chiharu-admin';
