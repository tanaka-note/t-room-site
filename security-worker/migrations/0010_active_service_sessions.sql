-- Store only a one-way session identifier so Security Center can present the
-- currently valid service sessions without retaining reusable credentials.
CREATE TABLE security_active_sessions (
  session_id_hash TEXT PRIMARY KEY,
  identity_id TEXT,
  service TEXT NOT NULL CHECK (service IN ('security', 'cloud', 'diary', 'billing', 'ai')),
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

CREATE INDEX idx_security_active_sessions_identity
ON security_active_sessions(identity_id, ended_at, expires_at);

CREATE INDEX idx_security_active_sessions_service
ON security_active_sessions(service, ended_at, expires_at);
