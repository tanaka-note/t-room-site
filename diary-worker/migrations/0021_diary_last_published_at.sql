ALTER TABLE diary_entries
ADD COLUMN last_published_at TEXT DEFAULT NULL;

-- Historical publication timestamps are reconstructed conservatively. A
-- deletion overwrites updated_at, so deleted entries fall back to created_at
-- rather than presenting the deletion time as a publication.
UPDATE diary_entries
SET last_published_at = CASE
  WHEN status <> 'published' THEN NULL
  WHEN revision <= 1 OR updated_at = created_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  WHEN deleted_at IS NOT NULL AND updated_at = deleted_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
END
WHERE last_published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_household_published_at
ON diary_entries(household_id, status, deleted_at, entry_date DESC, last_published_at DESC, id DESC);
