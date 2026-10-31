-- Metadata only: retain all existing financial records and request history.
CREATE TABLE household_datasets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  retired_at TEXT,
  lease_expires_at TEXT
);
INSERT INTO household_datasets(id,activated_at,retired_at)
SELECT dataset_id,CURRENT_TIMESTAMP,
  CASE WHEN dataset_id=(SELECT active_dataset FROM household_state WHERE id='main') THEN NULL ELSE CURRENT_TIMESTAMP END
FROM household_records GROUP BY dataset_id;
INSERT OR IGNORE INTO household_datasets(id,activated_at)
SELECT active_dataset,CURRENT_TIMESTAMP FROM household_state WHERE id='main';
CREATE INDEX idx_household_requests_created ON household_requests(created_at,request_id);
