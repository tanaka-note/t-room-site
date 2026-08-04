CREATE TABLE IF NOT EXISTS diary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_diary_entries_active_date
ON diary_entries(deleted_at, entry_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS diary_tags (
  entry_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entry_id, tag),
  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_diary_tags_tag
ON diary_tags(tag);
