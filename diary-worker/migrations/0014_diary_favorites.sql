CREATE TABLE IF NOT EXISTS diary_favorites (
  account_id TEXT NOT NULL,
  entry_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, entry_id),
  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_diary_favorites_account_created
ON diary_favorites(account_id, created_at DESC, entry_id DESC);

CREATE INDEX IF NOT EXISTS idx_diary_favorites_entry
ON diary_favorites(entry_id, account_id);
