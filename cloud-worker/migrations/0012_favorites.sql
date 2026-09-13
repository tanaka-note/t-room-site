CREATE TABLE cloud_favorite_files (
  owner_id TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES cloud_files(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, file_id)
);
CREATE INDEX cloud_favorite_files_target ON cloud_favorite_files(file_id);

CREATE TABLE cloud_favorite_folders (
  owner_id TEXT NOT NULL,
  folder_id INTEGER NOT NULL REFERENCES cloud_folders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, folder_id)
);
CREATE INDEX cloud_favorite_folders_target ON cloud_favorite_folders(folder_id);
