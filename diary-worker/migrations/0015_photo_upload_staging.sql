CREATE TABLE IF NOT EXISTS diary_photo_upload_sessions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  target_entry_id INTEGER,
  committed_entry_id INTEGER,
  committed_photo_ids TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'committed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (target_entry_id) REFERENCES diary_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (committed_entry_id) REFERENCES diary_entries(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_diary_photo_upload_sessions_cleanup
ON diary_photo_upload_sessions(status, expires_at, id);

CREATE TABLE IF NOT EXISTS diary_staged_photos (
  id TEXT PRIMARY KEY,
  upload_session_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_key TEXT NOT NULL UNIQUE,
  display_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  width INTEGER,
  height INTEGER,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (upload_session_id) REFERENCES diary_photo_upload_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_diary_staged_photos_session
ON diary_staged_photos(upload_session_id, created_at, id);

DROP TRIGGER IF EXISTS diary_validate_photo_upload_session_commit;

CREATE TRIGGER diary_validate_photo_upload_session_commit
BEFORE UPDATE OF status
ON diary_photo_upload_sessions
WHEN OLD.status != 'committed' AND NEW.status = 'committed'
BEGIN
  SELECT CASE WHEN
    NEW.committed_entry_id IS NULL
    OR NEW.committed_photo_ids IS NULL
    OR json_valid(NEW.committed_photo_ids) = 0
    OR json_type(NEW.committed_photo_ids) != 'array'
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.committed_photo_ids) selected
      LEFT JOIN diary_photos photo
        ON photo.id = selected.value
       AND photo.entry_id = NEW.committed_entry_id
      WHERE photo.id IS NULL
    )
  THEN RAISE(ABORT, 'staged photo commit is incomplete') END;
END;
