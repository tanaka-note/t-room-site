CREATE TABLE IF NOT EXISTS diary_trash_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  owner_account_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('personal', 'admin-retention', 'household')),
  entry_revision INTEGER NOT NULL,
  deleted_by_id TEXT,
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entry_id, owner_account_id, scope_type),
  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_diary_trash_scopes_owner
ON diary_trash_scopes(household_id, owner_account_id, scope_type, deleted_at DESC, entry_id DESC);

CREATE INDEX IF NOT EXISTS idx_diary_trash_scopes_entry
ON diary_trash_scopes(entry_id, household_id);

CREATE TABLE IF NOT EXISTS diary_media_deletion_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_diary_media_deletion_queue_entry
ON diary_media_deletion_queue(entry_id, id);

CREATE TRIGGER IF NOT EXISTS diary_queue_photo_cleanup_before_entry_delete
BEFORE DELETE ON diary_entries
BEGIN
  INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)
  SELECT OLD.id, original_key FROM diary_photos WHERE entry_id = OLD.id;
  INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)
  SELECT OLD.id, display_key FROM diary_photos WHERE entry_id = OLD.id;
  INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)
  SELECT OLD.id, thumbnail_key FROM diary_photos WHERE entry_id = OLD.id;
END;

-- Preserve every existing deleted entry in the Tanaka household for the Global Owner.
INSERT OR IGNORE INTO diary_trash_scopes (
  entry_id, owner_account_id, household_id, scope_type,
  entry_revision, deleted_by_id, deleted_at
)
SELECT
  id, 'main-admin', household_id, 'admin-retention',
  revision, deleted_by_id, deleted_at
FROM diary_entries
WHERE household_id = 'tanaka-household' AND deleted_at IS NOT NULL;

-- Give the wife account independent retention only when she authored and deleted the entry herself.
INSERT OR IGNORE INTO diary_trash_scopes (
  entry_id, owner_account_id, household_id, scope_type,
  entry_revision, deleted_by_id, deleted_at
)
SELECT
  id, 'wife-admin', household_id, 'personal',
  revision, deleted_by_id, deleted_at
FROM diary_entries
WHERE household_id = 'tanaka-household'
  AND author_id = 'wife-admin'
  AND deleted_by_id = 'wife-admin'
  AND deleted_at IS NOT NULL;

-- Chiharu's household remains a single personal trash scope; no Global Owner copy is created.
INSERT OR IGNORE INTO diary_trash_scopes (
  entry_id, owner_account_id, household_id, scope_type,
  entry_revision, deleted_by_id, deleted_at
)
SELECT
  id, 'chiharu-admin', household_id, 'personal',
  revision, deleted_by_id, deleted_at
FROM diary_entries
WHERE household_id = 'chiharu-household' AND deleted_at IS NOT NULL;
