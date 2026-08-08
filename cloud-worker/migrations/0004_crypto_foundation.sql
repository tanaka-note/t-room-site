CREATE TABLE IF NOT EXISTS cloud_crypto_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  crypto_version INTEGER NOT NULL DEFAULT 1,
  public_key_jwk TEXT NOT NULL,
  admin_private_cipher TEXT NOT NULL,
  admin_private_iv TEXT NOT NULL,
  recovery_private_cipher TEXT NOT NULL,
  recovery_private_iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE cloud_folders ADD COLUMN crypto_version INTEGER;
ALTER TABLE cloud_folders ADD COLUMN encrypted_name TEXT;
ALTER TABLE cloud_folders ADD COLUMN name_iv TEXT;
ALTER TABLE cloud_folders ADD COLUMN password_salt TEXT;
ALTER TABLE cloud_folders ADD COLUMN password_wrapped_key TEXT;
ALTER TABLE cloud_folders ADD COLUMN password_wrap_iv TEXT;
ALTER TABLE cloud_folders ADD COLUMN admin_wrapped_key TEXT;

CREATE TABLE IF NOT EXISTS cloud_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_role TEXT,
  details_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS cloud_security_events_time_idx
  ON cloud_security_events(occurred_at DESC);
