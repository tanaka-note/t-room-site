ALTER TABLE diary_entries
ADD COLUMN status TEXT NOT NULL DEFAULT 'published'
CHECK (status IN ('published', 'draft'));

ALTER TABLE diary_entries
ADD COLUMN draft_of_entry_id INTEGER;

ALTER TABLE diary_entries
ADD COLUMN draft_of_revision INTEGER;

ALTER TABLE diary_entries
ADD COLUMN draft_excluded_photo_ids TEXT;

CREATE INDEX IF NOT EXISTS idx_diary_entries_household_status_updated
ON diary_entries(household_id, status, deleted_at, updated_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_entries_single_edit_draft
ON diary_entries(household_id, draft_of_entry_id)
WHERE status = 'draft' AND deleted_at IS NULL AND draft_of_entry_id IS NOT NULL;
