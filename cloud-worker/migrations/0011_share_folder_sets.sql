CREATE TABLE IF NOT EXISTS cloud_share_folders (
  share_id INTEGER NOT NULL REFERENCES cloud_shares(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES cloud_folders(id) ON DELETE CASCADE,
  share_wrapped_folder_key TEXT,
  share_folder_key_iv TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, folder_id)
);

CREATE INDEX IF NOT EXISTS cloud_share_folders_folder_idx
  ON cloud_share_folders(folder_id, share_id);
