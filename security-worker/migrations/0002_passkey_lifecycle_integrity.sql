PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE security_service_links RENAME TO security_service_links_legacy;

CREATE TABLE security_service_links (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('cloud', 'diary', 'billing')),
  service_account_id TEXT NOT NULL,
  cloud_root_folder_id INTEGER,
  display_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE
);

INSERT INTO security_service_links
  (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status, created_at, updated_at)
SELECT id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status, created_at, updated_at
FROM security_service_links_legacy;

DROP TABLE security_service_links_legacy;

CREATE INDEX idx_security_service_links_identity
ON security_service_links(identity_id, service, status);

CREATE UNIQUE INDEX uq_security_service_links_current
ON security_service_links(
  identity_id,
  service,
  service_account_id,
  COALESCE(cloud_root_folder_id, -1)
)
WHERE status IN ('pending', 'active');

ALTER TABLE security_credentials
ADD COLUMN registered_via_invitation_id TEXT REFERENCES security_invitations(id);

CREATE UNIQUE INDEX uq_security_credentials_invitation
ON security_credentials(registered_via_invitation_id)
WHERE registered_via_invitation_id IS NOT NULL;

CREATE TABLE security_tcloud_client_vaults (
  credential_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  public_key_fingerprint TEXT,
  encrypted_payload TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO security_tcloud_client_vaults
  (credential_id, identity_id, public_key_jwk, encrypted_payload, payload_iv, created_at, updated_at)
SELECT e.credential_id, e.identity_id, e.public_key_jwk, e.encrypted_payload, e.payload_iv, e.created_at, e.updated_at
FROM security_tcloud_key_envelopes e
WHERE e.envelope_type = 'client_private_prf'
  AND e.public_key_jwk IS NOT NULL
  AND e.encrypted_payload IS NOT NULL
  AND e.payload_iv IS NOT NULL
  AND e.service_link_id = (
    SELECT MIN(candidate.service_link_id)
    FROM security_tcloud_key_envelopes candidate
    WHERE candidate.credential_id = e.credential_id
      AND candidate.envelope_type = 'client_private_prf'
  );

CREATE TABLE security_setup_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
  expires_at INTEGER NOT NULL,
  last_user_verification_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id) ON DELETE CASCADE
);

CREATE INDEX idx_security_setup_sessions_expiry
ON security_setup_sessions(expires_at, status);

CREATE TABLE security_runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  passkey_session_epoch INTEGER NOT NULL DEFAULT 1,
  switch_observed_enabled INTEGER NOT NULL DEFAULT 1 CHECK (switch_observed_enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO security_runtime_state (id, passkey_session_epoch, switch_observed_enabled)
VALUES (1, 1, 1)
ON CONFLICT(id) DO NOTHING;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
