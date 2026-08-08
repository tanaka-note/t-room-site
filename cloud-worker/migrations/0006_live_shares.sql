ALTER TABLE cloud_folders ADD COLUMN parent_wrapped_key TEXT;
ALTER TABLE cloud_folders ADD COLUMN parent_wrap_iv TEXT;

CREATE TABLE IF NOT EXISTS cloud_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  encrypted_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'file')),
  target_id INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_wrapped_key TEXT NOT NULL,
  password_wrap_iv TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by = 'admin'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stopped_at INTEGER
);

CREATE INDEX IF NOT EXISTS cloud_shares_target_idx
  ON cloud_shares(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_shares_expiry_idx
  ON cloud_shares(stopped_at, expires_at);

CREATE TABLE IF NOT EXISTS cloud_share_attempts (
  share_id INTEGER NOT NULL REFERENCES cloud_shares(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until INTEGER,
  PRIMARY KEY (share_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS cloud_share_attempts_expiry_idx
  ON cloud_share_attempts(locked_until);

CREATE TABLE IF NOT EXISTS cloud_share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id INTEGER NOT NULL REFERENCES cloud_shares(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('unlock_success', 'unlock_failed', 'download_started', 'download_completed', 'download_failed')),
  file_id INTEGER,
  session_id TEXT,
  error_code TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS cloud_share_events_share_idx
  ON cloud_share_events(share_id, occurred_at DESC);
