CREATE TABLE IF NOT EXISTS diary_accounts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  must_change_password INTEGER NOT NULL DEFAULT 1,
  can_view_trash INTEGER NOT NULL DEFAULT 1,
  can_permanently_delete INTEGER NOT NULL DEFAULT 1,
  can_view_investment INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO diary_accounts (
  id, household_id, display_name, login_id, role,
  must_change_password, can_view_trash, can_permanently_delete,
  can_view_investment, session_version, active
) VALUES (
  'chiharu-admin', 'chiharu-household', '田中千晴',
  'flw2-0203freedom@ezweb.ne.jp', 'admin',
  1, 1, 1, 0, 1, 1
);

ALTER TABLE diary_entries
ADD COLUMN household_id TEXT NOT NULL DEFAULT 'tanaka-household';

CREATE INDEX IF NOT EXISTS idx_diary_entries_household_date
ON diary_entries(household_id, deleted_at, entry_date DESC, id DESC);
