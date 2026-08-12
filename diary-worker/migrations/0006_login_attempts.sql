CREATE TABLE IF NOT EXISTS diary_login_attempts (
  fingerprint TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_diary_login_attempts_locked_until
ON diary_login_attempts(locked_until);
