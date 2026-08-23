-- Retire only invitation-created Identities that never reached registration or
-- service use. Invitations, links, and audit history remain as logical history.
UPDATE security_service_links
SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
WHERE status IN ('pending', 'active')
  AND identity_id IN (
    SELECT identity.id
    FROM security_identities identity
    WHERE identity.id != 'primary-admin'
      AND identity.status = 'invited'
      AND identity.last_login_at IS NULL
      AND identity.last_seen_at IS NULL
      AND EXISTS (
        SELECT 1 FROM security_invitations revoked
        WHERE revoked.identity_id = identity.id AND revoked.status = 'revoked'
      )
      AND NOT EXISTS (
        SELECT 1 FROM security_invitations active_invite
        WHERE active_invite.identity_id = identity.id AND active_invite.status = 'active'
      )
      AND NOT EXISTS (SELECT 1 FROM security_credentials credential WHERE credential.identity_id = identity.id)
      AND NOT EXISTS (SELECT 1 FROM security_setup_sessions setup WHERE setup.identity_id = identity.id)
      AND NOT EXISTS (SELECT 1 FROM security_tcloud_client_vaults vault WHERE vault.identity_id = identity.id)
      AND NOT EXISTS (SELECT 1 FROM security_tcloud_key_envelopes envelope WHERE envelope.identity_id = identity.id)
      AND NOT EXISTS (SELECT 1 FROM security_handoffs handoff WHERE handoff.identity_id = identity.id)
      AND NOT EXISTS (
        SELECT 1 FROM security_audit_events audit
        WHERE audit.identity_id = identity.id
          AND audit.event_type IN (
            'invite_used',
            'passkey_registration',
            'identity_approved',
            'passkey_login_success',
            'passkey_authentication_success',
            'password_login_success',
            'session_resume',
            'tcloud_key_envelope_saved',
            'tcloud_key_delegated'
          )
      )
  );

UPDATE security_identities AS identity
SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
WHERE identity.id != 'primary-admin'
  AND identity.status = 'invited'
  AND identity.last_login_at IS NULL
  AND identity.last_seen_at IS NULL
  AND EXISTS (
    SELECT 1 FROM security_invitations revoked
    WHERE revoked.identity_id = identity.id AND revoked.status = 'revoked'
  )
  AND NOT EXISTS (
    SELECT 1 FROM security_invitations active_invite
    WHERE active_invite.identity_id = identity.id AND active_invite.status = 'active'
  )
  AND NOT EXISTS (SELECT 1 FROM security_credentials credential WHERE credential.identity_id = identity.id)
  AND NOT EXISTS (SELECT 1 FROM security_setup_sessions setup WHERE setup.identity_id = identity.id)
  AND NOT EXISTS (SELECT 1 FROM security_tcloud_client_vaults vault WHERE vault.identity_id = identity.id)
  AND NOT EXISTS (SELECT 1 FROM security_tcloud_key_envelopes envelope WHERE envelope.identity_id = identity.id)
  AND NOT EXISTS (SELECT 1 FROM security_handoffs handoff WHERE handoff.identity_id = identity.id)
  AND NOT EXISTS (
    SELECT 1 FROM security_audit_events audit
    WHERE audit.identity_id = identity.id
      AND audit.event_type IN (
        'invite_used',
        'passkey_registration',
        'identity_approved',
        'passkey_login_success',
        'passkey_authentication_success',
        'password_login_success',
        'session_resume',
        'tcloud_key_envelope_saved',
        'tcloud_key_delegated'
      )
  );
