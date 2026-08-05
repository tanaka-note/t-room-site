PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  password_salt TEXT,
  password_hash TEXT,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  session_version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO billing_accounts (id, login_id, display_name, role) VALUES
  ('owner', 'sub@a-tanaka.jp', '田中宏知', 'owner'),
  ('chiharu', 'chiharu', '田中千晴', 'member'),
  ('hideaki', 'hideaki', '田中秀晃', 'member'),
  ('masami', 'masami', '田中暢美', 'member'),
  ('yuuka', 'yuuka', '田中佑果', 'member');

CREATE TABLE IF NOT EXISTS billing_opening_balances (
  account_id TEXT PRIMARY KEY,
  effective_date TEXT NOT NULL CHECK (effective_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  balance_yen INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES billing_accounts(id),
  FOREIGN KEY (updated_by) REFERENCES billing_accounts(id)
);

CREATE TABLE IF NOT EXISTS billing_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  entry_date TEXT NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  category TEXT NOT NULL CHECK (category IN ('deposit', 'purchase', 'adjustment')),
  amount_yen INTEGER NOT NULL CHECK (
    (category = 'deposit' AND amount_yen > 0) OR
    (category = 'purchase' AND amount_yen < 0) OR
    (category = 'adjustment' AND amount_yen != 0)
  ),
  description TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (account_id) REFERENCES billing_accounts(id),
  FOREIGN KEY (created_by) REFERENCES billing_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_billing_entries_account_date
  ON billing_entries(account_id, entry_date, id);
CREATE INDEX IF NOT EXISTS idx_billing_entries_active
  ON billing_entries(account_id, deleted_at, entry_date);

CREATE TABLE IF NOT EXISTS billing_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_account_id TEXT,
  target_account_id TEXT,
  entry_id INTEGER,
  attempted_login_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_account_id) REFERENCES billing_accounts(id),
  FOREIGN KEY (target_account_id) REFERENCES billing_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_billing_audit_logs_occurred
  ON billing_audit_logs(occurred_at DESC, id DESC);
