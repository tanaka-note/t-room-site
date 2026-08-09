CREATE TABLE IF NOT EXISTS diary_photos (
  id TEXT PRIMARY KEY,
  entry_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_size INTEGER NOT NULL,
  original_key TEXT NOT NULL UNIQUE,
  display_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  width INTEGER,
  height INTEGER,
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_diary_photos_entry
ON diary_photos(entry_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_diary_photos_created
ON diary_photos(created_at DESC, id DESC);
