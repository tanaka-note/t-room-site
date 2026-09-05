-- Retire the legacy passkey link; Cloud's ID/password account is unchanged.
-- Do not repurpose its ID: existing handoffs/cookies must stay revoked.
UPDATE security_service_links
SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
WHERE identity_id = 'primary-admin' AND service = 'cloud'
  AND service_account_id = 'subadmin' AND status != 'disabled';

UPDATE security_active_sessions
SET ended_at = CURRENT_TIMESTAMP, end_reason = 'service_link_disabled'
WHERE service = 'cloud' AND auth_method = 'passkey' AND ended_at IS NULL
  AND service_link_id IN (
    SELECT id FROM security_service_links WHERE identity_id = 'primary-admin'
      AND service = 'cloud' AND service_account_id = 'subadmin'
  );
