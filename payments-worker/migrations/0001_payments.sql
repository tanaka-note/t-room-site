CREATE TABLE payments_accounts (
  id TEXT PRIMARY KEY CHECK(id = 'owner'),
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE payments_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES payments_accounts(id),
  paid_on TEXT NOT NULL,
  payee TEXT NOT NULL CHECK(length(payee) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 240),
  amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount BETWEEN 1 AND 999999999999),
  start_month TEXT NOT NULL,
  months INTEGER NOT NULL CHECK(typeof(months) = 'integer' AND months BETWEEN 1 AND 1200),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 2000),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX payments_entries_order ON payments_entries(account_id, paid_on DESC, id) WHERE deleted_at IS NULL;
-- Idempotency keys make retries after a lost network response safe.
CREATE TABLE payments_requests (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER payments_version_guard BEFORE UPDATE ON payments_entries
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'payments_version_conflict'); END;
