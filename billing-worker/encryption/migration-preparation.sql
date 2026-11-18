CREATE TABLE billing_encryption_migration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  audit_through_id INTEGER NOT NULL CHECK (audit_through_id >= 0)
);

CREATE TABLE billing_encryption_candidate_ledgers (
  generation TEXT NOT NULL REFERENCES billing_encryption_migration(generation),
  ledger_id TEXT NOT NULL,
  account_id TEXT REFERENCES billing_accounts(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT,
  signature TEXT,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  staged_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_count <= record_count),
  staged_bytes INTEGER NOT NULL DEFAULT 0 CHECK (staged_bytes <= 8388608),
  CHECK ((digest IS NULL) = (signature IS NULL)),
  PRIMARY KEY (generation, ledger_id),
  UNIQUE (generation, account_id)
);
CREATE UNIQUE INDEX billing_candidate_one_audit_ledger
  ON billing_encryption_candidate_ledgers(generation) WHERE account_id IS NULL;

CREATE TABLE billing_encryption_candidate_records (
  generation TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (generation, ledger_id, id),
  FOREIGN KEY (generation, ledger_id) REFERENCES billing_encryption_candidate_ledgers(generation, ledger_id)
);

CREATE TRIGGER billing_candidate_record_insert BEFORE INSERT ON billing_encryption_candidate_records
WHEN NOT EXISTS (SELECT 1 FROM billing_encryption_candidate_ledgers
  WHERE generation = NEW.generation AND ledger_id = NEW.ledger_id AND revision = NEW.revision)
BEGIN SELECT RAISE(ABORT, 'billing candidate revision mismatch'); END;
CREATE TRIGGER billing_candidate_record_inserted AFTER INSERT ON billing_encryption_candidate_records
BEGIN
  UPDATE billing_encryption_candidate_ledgers SET staged_count = staged_count + 1,
    staged_bytes = staged_bytes + length(NEW.ciphertext)
  WHERE generation = NEW.generation AND ledger_id = NEW.ledger_id;
END;
CREATE TRIGGER billing_candidate_record_immutable BEFORE UPDATE ON billing_encryption_candidate_records
WHEN NEW.generation IS NOT OLD.generation OR NEW.ledger_id IS NOT OLD.ledger_id OR NEW.id IS NOT OLD.id
  OR NEW.revision IS NOT OLD.revision OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
BEGIN SELECT RAISE(ABORT, 'billing candidate ciphertext changed'); END;

-- These fences also cover requests served by an older Worker during rollout.
-- The migration row and frozen audit boundary are recorded in one statement.
CREATE TRIGGER billing_freeze_entries_insert BEFORE INSERT ON billing_entries
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_entries_update BEFORE UPDATE ON billing_entries
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_entries_delete BEFORE DELETE ON billing_entries
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;

CREATE TRIGGER billing_freeze_settlements_insert BEFORE INSERT ON billing_settlements
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_settlements_update BEFORE UPDATE ON billing_settlements
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_settlements_delete BEFORE DELETE ON billing_settlements
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;

CREATE TRIGGER billing_freeze_balances_insert BEFORE INSERT ON billing_opening_balances
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_balances_update BEFORE UPDATE ON billing_opening_balances
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_balances_delete BEFORE DELETE ON billing_opening_balances
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;

CREATE TRIGGER billing_freeze_financial_audit_insert BEFORE INSERT ON billing_audit_logs
WHEN (NEW.entry_id IS NOT NULL OR NEW.details_json <> '{}')
  AND EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_audit_update BEFORE UPDATE ON billing_audit_logs
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1
  AND (OLD.id <= audit_through_id OR NEW.id <= audit_through_id OR NEW.entry_id IS NOT NULL OR NEW.details_json <> '{}'))
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
CREATE TRIGGER billing_freeze_audit_delete BEFORE DELETE ON billing_audit_logs
WHEN EXISTS (SELECT 1 FROM billing_encryption_migration WHERE id = 1 AND OLD.id <= audit_through_id)
BEGIN SELECT RAISE(ABORT, 'billing migration in progress'); END;
