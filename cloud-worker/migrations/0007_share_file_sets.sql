CREATE TABLE IF NOT EXISTS cloud_share_files (
  share_id INTEGER NOT NULL REFERENCES cloud_shares(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES cloud_files(id) ON DELETE CASCADE,
  share_wrapped_file_key TEXT,
  share_file_key_iv TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, file_id)
);

CREATE INDEX IF NOT EXISTS cloud_share_files_file_idx
  ON cloud_share_files(file_id, share_id);
