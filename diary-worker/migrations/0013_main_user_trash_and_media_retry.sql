ALTER TABLE diary_accounts
ADD COLUMN can_manage_entries INTEGER NOT NULL DEFAULT 0;

UPDATE diary_accounts
SET can_manage_entries = CASE WHEN role = 'admin' OR id = 'main-user' THEN 1 ELSE 0 END;

UPDATE diary_accounts
SET role = 'user',
    can_manage_entries = 1,
    can_view_trash = 1,
    can_permanently_delete = 1,
    session_version = session_version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'main-user';

-- Preserve already-deleted entries in main-user's personal trash when both
-- authorship and deletion actor belong to the same account.
INSERT OR IGNORE INTO diary_trash_scopes (
  entry_id, owner_account_id, household_id, scope_type,
  entry_revision, deleted_by_id, deleted_at
)
SELECT
  id, 'main-user', household_id, 'personal',
  revision, deleted_by_id, deleted_at
FROM diary_entries
WHERE household_id = 'tanaka-household'
  AND author_id = 'main-user'
  AND deleted_by_id = 'main-user'
  AND deleted_at IS NOT NULL;

ALTER TABLE diary_media_deletion_queue
ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE diary_media_deletion_queue
ADD COLUMN last_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_diary_media_deletion_queue_attempt
ON diary_media_deletion_queue(last_attempt_at, id);
