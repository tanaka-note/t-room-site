ALTER TABLE cloud_folders ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS cloud_folder_unlocks (
  session_id TEXT NOT NULL,
  folder_id INTEGER NOT NULL REFERENCES cloud_folders(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, folder_id)
);

CREATE INDEX IF NOT EXISTS cloud_folder_unlocks_expiry_idx
  ON cloud_folder_unlocks(expires_at);
