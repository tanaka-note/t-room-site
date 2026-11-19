-- Only public device keys and authorization bindings; never user decryption keys.
CREATE TABLE cloud_windows_devices (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
  public_key_json TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  enrollment_session_hash TEXT NOT NULL,
  enrollment_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE cloud_windows_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES cloud_windows_devices(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('enroll','renew')),
  nonce_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  consumed_at INTEGER,
  proof_id TEXT
);
CREATE INDEX cloud_windows_challenge_expiry ON cloud_windows_challenges(expires_at);
CREATE TABLE cloud_windows_access (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES cloud_windows_devices(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cloud_windows_access_expiry ON cloud_windows_access(expires_at);
