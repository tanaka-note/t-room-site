PRAGMA foreign_keys = OFF;

ALTER TABLE billing_entries RENAME TO billing_entries_legacy;

CREATE TABLE billing_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice', 'payment_notice')),
  entry_date TEXT NOT NULL CHECK (entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  category TEXT NOT NULL CHECK (category IN ('purchase', 'discount', 'income', 'offset', 'other')),
  amount_yen INTEGER NOT NULL CHECK (
    (category = 'purchase' AND amount_yen > 0) OR
    (category IN ('discount', 'income', 'offset') AND amount_yen < 0) OR
    (category = 'other' AND amount_yen != 0)
  ),
  description TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  CHECK (document_type = 'invoice' OR category != 'discount'),
  FOREIGN KEY (account_id) REFERENCES billing_accounts(id),
  FOREIGN KEY (created_by) REFERENCES billing_accounts(id)
);

INSERT INTO billing_entries (
  id, account_id, document_type, entry_date, category, amount_yen,
  description, note, created_by, created_at, updated_at, deleted_at
)
SELECT
  id,
  account_id,
  'invoice',
  entry_date,
  CASE category WHEN 'purchase' THEN 'purchase' WHEN 'deposit' THEN 'income' ELSE 'other' END,
  CASE category WHEN 'purchase' THEN ABS(amount_yen) WHEN 'deposit' THEN -ABS(amount_yen) ELSE amount_yen END,
  description,
  note,
  created_by,
  created_at,
  updated_at,
  deleted_at
FROM billing_entries_legacy;

DROP TABLE billing_entries_legacy;

CREATE INDEX idx_billing_entries_account_date
  ON billing_entries(account_id, entry_date, id);
CREATE INDEX idx_billing_entries_active
  ON billing_entries(account_id, deleted_at, entry_date);
CREATE INDEX idx_billing_entries_document
  ON billing_entries(account_id, document_type, entry_date, deleted_at);

PRAGMA foreign_keys = ON;
