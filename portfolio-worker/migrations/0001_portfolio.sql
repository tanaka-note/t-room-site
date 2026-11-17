CREATE TABLE portfolio_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO portfolio_accounts(id,display_name,role) VALUES
 ('owner','資産運用報告・管理者','owner'),('viewer','資産運用報告・閲覧者','viewer');
CREATE TABLE portfolio_state (
  id TEXT PRIMARY KEY CHECK(id='main'), revision INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL CHECK(json_valid(metadata))
);
CREATE TRIGGER portfolio_revision BEFORE UPDATE ON portfolio_state
WHEN NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'revision conflict'); END;
CREATE TABLE portfolio_records (
  period TEXT PRIMARY KEY, time TEXT,
  raw_market_value INTEGER NOT NULL CHECK(raw_market_value>=0),
  assets TEXT CHECK(assets IS NULL OR json_valid(assets)),
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE portfolio_changes (
  revision INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL, period TEXT NOT NULL,
  previous_record TEXT, saved_record TEXT NOT NULL,
  updated_at TEXT NOT NULL, account_id TEXT NOT NULL
);
