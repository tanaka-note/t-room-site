CREATE TABLE billing_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  settlement_date TEXT NOT NULL CHECK (settlement_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  method TEXT NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'offset', 'other', 'unspecified')),
  amount_yen INTEGER NOT NULL CHECK (amount_yen > 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  legacy_entry_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (account_id) REFERENCES billing_accounts(id),
  FOREIGN KEY (created_by) REFERENCES billing_accounts(id)
);

INSERT INTO billing_settlements (
  account_id, settlement_date, direction, method, amount_yen, note,
  created_by, legacy_entry_id, created_at, updated_at, deleted_at
)
SELECT
  account_id,
  entry_date,
  CASE document_type WHEN 'invoice' THEN 'incoming' ELSE 'outgoing' END,
  'unspecified',
  ABS(amount_yen),
  note,
  created_by,
  id,
  created_at,
  updated_at,
  deleted_at
FROM billing_entries
WHERE category = 'income';

CREATE INDEX idx_billing_settlements_account_date
  ON billing_settlements(account_id, settlement_date, deleted_at, id);

PRAGMA optimize;
