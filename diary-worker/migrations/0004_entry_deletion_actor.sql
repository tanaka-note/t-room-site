ALTER TABLE diary_entries
ADD COLUMN deleted_by_id TEXT;

ALTER TABLE diary_entries
ADD COLUMN deleted_by_name TEXT;
