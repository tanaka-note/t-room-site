CREATE TABLE household_accounts (
  id TEXT PRIMARY KEY CHECK (id IN ('owner','viewer')),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 1,
  CHECK ((id='owner' AND role='owner') OR (id='viewer' AND role='viewer'))
);
INSERT INTO household_accounts(id,display_name,role) VALUES ('owner','田中宏知','owner'),('viewer','共有ページ','viewer');
CREATE TABLE household_state (id TEXT PRIMARY KEY CHECK(id='main'),revision INTEGER NOT NULL DEFAULT 0,active_dataset TEXT NOT NULL);
INSERT INTO household_state VALUES ('main',0,'initial');
CREATE TRIGGER household_revision_guard BEFORE UPDATE ON household_state WHEN NEW.revision!=OLD.revision+1 BEGIN SELECT RAISE(ABORT,'household_revision_conflict'); END;
CREATE TABLE household_records (dataset_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('accounts','transactions','snapshots','historical','categories')),id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(dataset_id,kind,id));
CREATE TABLE household_requests (request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
