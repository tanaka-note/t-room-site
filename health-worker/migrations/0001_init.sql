-- No health dates, symptoms, text or decrypted keys are stored here.
CREATE TABLE health_records (
  record_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL CHECK (account_id = 'nobumi'),
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
