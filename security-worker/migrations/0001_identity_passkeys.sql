PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS security_identities (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'pending_approval', 'active', 'disabled')),
  is_security_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_security_admin IN (0, 1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS security_service_links (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('cloud', 'diary', 'billing')),
  service_account_id TEXT NOT NULL,
  cloud_root_folder_id INTEGER,
  display_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identity_id, service, service_account_id, cloud_root_folder_id),
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_service_links_identity
ON security_service_links(identity_id, service, status);

CREATE TABLE IF NOT EXISTS security_invitations (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  link_set_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_by_identity_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_identity_id) REFERENCES security_identities(id)
);

CREATE INDEX IF NOT EXISTS idx_security_invitations_identity
ON security_invitations(identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_invitations_expiry
ON security_invitations(status, expires_at);

CREATE TABLE IF NOT EXISTS security_credentials (
  credential_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  prf_enabled INTEGER NOT NULL DEFAULT 0 CHECK (prf_enabled IN (0, 1)),
  prf_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  label TEXT NOT NULL DEFAULT '端末のパスキー',
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_credentials_identity
ON security_credentials(identity_id, status, registered_at DESC);

CREATE TABLE IF NOT EXISTS security_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap_registration', 'invite_registration', 'authentication', 'prf_assertion')),
  challenge_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT,
  invitation_id TEXT,
  service TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (invitation_id) REFERENCES security_invitations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_challenges_expiry
ON security_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS security_handoffs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links(id),
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id)
);

CREATE INDEX IF NOT EXISTS idx_security_handoffs_expiry
ON security_handoffs(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS security_tcloud_key_envelopes (
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
  FOREIGN KEY (service_link_id) REFERENCES security_service_links(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_audit_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  service TEXT NOT NULL CHECK (service IN ('security', 'cloud', 'diary', 'billing')),
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
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_security_audit_occurred
ON security_audit_events(occurred_at DESC, event_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_filters
ON security_audit_events(service, outcome, auth_method, event_type, occurred_at DESC);
