-- Extend Security Center's service constraints without changing existing IDs
-- or invalidating existing handoffs, encrypted envelopes, audit records, or
-- active sessions.
CREATE TABLE security_service_links_next (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('cloud', 'diary', 'billing', 'ai', 'downloader')),
  service_account_id TEXT NOT NULL,
  cloud_root_folder_id INTEGER,
  display_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE
);

INSERT INTO security_service_links_next
  (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status, created_at, updated_at)
SELECT id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status, created_at, updated_at
FROM security_service_links;

CREATE TABLE security_handoffs_next (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links_next(id),
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id)
);

INSERT INTO security_handoffs_next
  (id, token_hash, identity_id, service_link_id, credential_id, expires_at, consumed_at, created_at, session_epoch)
SELECT id, token_hash, identity_id, service_link_id, credential_id, expires_at, consumed_at, created_at, session_epoch
FROM security_handoffs;

CREATE TABLE security_tcloud_key_envelopes_next (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  envelope_type TEXT NOT NULL CHECK (envelope_type IN ('admin_private_prf', 'client_private_prf', 'folder_key_rsa')),
  public_key_jwk TEXT,
  encrypted_payload TEXT,
  payload_iv TEXT,
  wrapped_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (credential_id, service_link_id, envelope_type),
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links_next(id) ON DELETE CASCADE
);

INSERT INTO security_tcloud_key_envelopes_next
  (id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk,
   encrypted_payload, payload_iv, wrapped_key, created_at, updated_at)
SELECT id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk,
       encrypted_payload, payload_iv, wrapped_key, created_at, updated_at
FROM security_tcloud_key_envelopes;

DROP TABLE security_handoffs;
DROP TABLE security_tcloud_key_envelopes;
DROP TABLE security_service_links;

ALTER TABLE security_service_links_next RENAME TO security_service_links;
ALTER TABLE security_handoffs_next RENAME TO security_handoffs;
ALTER TABLE security_tcloud_key_envelopes_next RENAME TO security_tcloud_key_envelopes;

CREATE INDEX idx_security_service_links_identity
ON security_service_links(identity_id, service, status);
CREATE INDEX idx_security_handoffs_expiry
ON security_handoffs(expires_at, consumed_at);
CREATE UNIQUE INDEX uq_security_service_links_current
ON security_service_links(identity_id, service, service_account_id, COALESCE(cloud_root_folder_id, -1))
WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX uq_security_service_links_exclusive_current
ON security_service_links(service, service_account_id)
WHERE service IN ('diary', 'billing')
  AND status IN ('pending', 'active')
  AND NOT (
    identity_id = 'primary-admin'
    AND service = 'diary'
    AND service_account_id = 'main-user'
  );

CREATE TABLE security_audit_events_next (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  service TEXT NOT NULL CHECK (service IN ('security', 'cloud', 'diary', 'billing', 'ai', 'downloader')),
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'blocked', 'cancelled', 'info')),
  identity_id TEXT,
  service_account_id TEXT,
  role TEXT,
  auth_method TEXT CHECK (auth_method IS NULL OR auth_method IN ('password', 'passkey', 'system')),
  session_id_hash TEXT,
  source_hash TEXT,
  user_agent TEXT,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  service_link_id TEXT,
  service_account_label TEXT
);

INSERT INTO security_audit_events_next
  (event_id, occurred_at, received_at, service, event_type, outcome, identity_id,
   service_account_id, role, auth_method, session_id_hash, source_hash, user_agent,
   target_type, target_id, details_json, service_link_id, service_account_label)
SELECT event_id, occurred_at, received_at, service, event_type, outcome, identity_id,
       service_account_id, role, auth_method, session_id_hash, source_hash, user_agent,
       target_type, target_id, details_json, service_link_id, service_account_label
FROM security_audit_events;

DROP TABLE security_audit_events;
ALTER TABLE security_audit_events_next RENAME TO security_audit_events;
CREATE INDEX idx_security_audit_occurred
ON security_audit_events(occurred_at DESC, event_id);
CREATE INDEX idx_security_audit_filters
ON security_audit_events(service, outcome, auth_method, event_type, occurred_at DESC);
CREATE UNIQUE INDEX uq_security_audit_session_resume_minute
ON security_audit_events(service, session_id_hash, substr(occurred_at, 1, 16))
WHERE event_type = 'session_resume' AND session_id_hash IS NOT NULL;

CREATE TABLE security_active_sessions_next (
  session_id_hash TEXT PRIMARY KEY,
  identity_id TEXT,
  service TEXT NOT NULL CHECK (service IN ('security', 'cloud', 'diary', 'billing', 'ai', 'downloader')),
  service_link_id TEXT,
  service_account_id TEXT,
  credential_id TEXT,
  role TEXT,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'passkey')),
  session_version TEXT NOT NULL,
  passkey_session_epoch INTEGER,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO security_active_sessions_next
  (session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id,
   role, auth_method, session_version, passkey_session_epoch, started_at, last_seen_at,
   expires_at, ended_at, end_reason, created_at, updated_at)
SELECT session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id,
       role, auth_method, session_version, passkey_session_epoch, started_at, last_seen_at,
       expires_at, ended_at, end_reason, created_at, updated_at
FROM security_active_sessions;

DROP TABLE security_active_sessions;
ALTER TABLE security_active_sessions_next RENAME TO security_active_sessions;
CREATE INDEX idx_security_active_sessions_identity
ON security_active_sessions(identity_id, ended_at, expires_at);
CREATE INDEX idx_security_active_sessions_service
ON security_active_sessions(service, ended_at, expires_at);

INSERT INTO security_service_links
  (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
SELECT lower(hex(randomblob(16))), identity.id, 'downloader', 'owner', NULL, 'T-lain Downloader 管理者',
       CASE WHEN identity.status = 'active' AND EXISTS (
         SELECT 1 FROM security_credentials credential
         WHERE credential.identity_id = identity.id AND credential.status = 'active'
       ) THEN 'active' ELSE 'pending' END
FROM security_identities identity
WHERE identity.id = 'primary-admin'
  AND NOT EXISTS (
    SELECT 1 FROM security_service_links link
    WHERE link.identity_id = identity.id AND link.service = 'downloader'
      AND link.service_account_id = 'owner' AND link.status IN ('pending', 'active')
  );
