ALTER TABLE billing_accounts
ADD COLUMN password_pepper_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS billing_login_attempts (
  fingerprint TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_billing_login_attempts_locked_until
ON billing_login_attempts(locked_until);
