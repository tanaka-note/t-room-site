-- Preserve the existing household, generations, revision and receipts verbatim.
CREATE TABLE household_state_scoped (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  active_dataset TEXT NOT NULL UNIQUE
);
INSERT INTO household_state_scoped SELECT * FROM household_state;
DROP TABLE household_state;
ALTER TABLE household_state_scoped RENAME TO household_state;
CREATE TRIGGER household_revision_guard BEFORE UPDATE ON household_state
WHEN NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'household_revision_conflict'); END;

CREATE TABLE household_accounts_scoped (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 1,
  household_id TEXT NOT NULL REFERENCES household_state(id),
  CHECK (id!='owner' OR (role='owner' AND household_id='main')),
  CHECK (id!='viewer' OR (role='viewer' AND household_id='main'))
);
INSERT INTO household_accounts_scoped SELECT *, 'main' FROM household_accounts;
DROP TABLE household_accounts;
ALTER TABLE household_accounts_scoped RENAME TO household_accounts;

ALTER TABLE household_datasets ADD COLUMN household_id TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_household_datasets_household ON household_datasets(household_id,id);
CREATE TABLE household_requests_scoped (
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  household_id TEXT NOT NULL DEFAULT 'main' REFERENCES household_state(id),
  PRIMARY KEY(household_id,request_id)
);
INSERT INTO household_requests_scoped SELECT *, 'main' FROM household_requests;
DROP TABLE household_requests;
ALTER TABLE household_requests_scoped RENAME TO household_requests;
CREATE INDEX idx_household_requests_created ON household_requests(household_id,created_at,request_id);

-- Only standard categories: no financial accounts, balances, entries or history.
INSERT INTO household_state VALUES ('chiharu',0,'chiharu-initial');
INSERT INTO household_datasets(id,activated_at,household_id)
VALUES ('chiharu-initial',CURRENT_TIMESTAMP,'chiharu');
INSERT INTO household_records(dataset_id,kind,id,payload)
SELECT 'chiharu-initial',kind,id,payload FROM household_records
WHERE dataset_id=(SELECT active_dataset FROM household_state WHERE id='main')
  AND kind='categories' AND json_extract(payload,'$.builtin')=1;
INSERT INTO household_accounts(id,display_name,role,household_id)
VALUES ('chiharu-admin','田中千晴','owner','chiharu');
