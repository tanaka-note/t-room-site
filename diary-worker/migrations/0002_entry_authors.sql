ALTER TABLE diary_entries
ADD COLUMN author_id TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE diary_entries
ADD COLUMN author_name TEXT NOT NULL DEFAULT '不明';
