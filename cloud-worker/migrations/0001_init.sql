CREATE TABLE IF NOT EXISTS cloud_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES cloud_folders(id),
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS cloud_folders_parent_idx
  ON cloud_folders(parent_id, deleted_at, name);

CREATE TABLE IF NOT EXISTS cloud_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER REFERENCES cloud_folders(id),
  object_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT,
  stream_uid TEXT,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video', 'audio', 'document', 'other')),
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'failed')),
  multipart_upload_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS cloud_files_folder_idx
  ON cloud_files(folder_id, deleted_at, status, created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_files_search_idx
  ON cloud_files(original_name, deleted_at);

CREATE TABLE IF NOT EXISTS cloud_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_role TEXT,
  target_type TEXT,
  target_id INTEGER,
  details_json TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS cloud_audit_logs_time_idx
  ON cloud_audit_logs(occurred_at DESC);

CREATE TABLE IF NOT EXISTS cloud_login_attempts (
  fingerprint TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until INTEGER
);
