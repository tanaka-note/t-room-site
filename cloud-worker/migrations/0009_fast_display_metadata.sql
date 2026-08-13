ALTER TABLE cloud_files ADD COLUMN display_metadata_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_files ADD COLUMN display_name TEXT;
ALTER TABLE cloud_files ADD COLUMN display_mime_type TEXT;
ALTER TABLE cloud_files ADD COLUMN display_media_kind TEXT;
ALTER TABLE cloud_files ADD COLUMN display_last_modified INTEGER;
ALTER TABLE cloud_files ADD COLUMN display_duration_seconds INTEGER;
ALTER TABLE cloud_files ADD COLUMN display_thumbnail_key TEXT;

CREATE INDEX IF NOT EXISTS idx_cloud_files_display_name
  ON cloud_files(folder_id, display_name COLLATE NOCASE)
  WHERE deleted_at IS NULL AND status = 'ready' AND display_metadata_version = 1;

CREATE INDEX IF NOT EXISTS idx_cloud_files_display_kind
  ON cloud_files(folder_id, display_media_kind)
  WHERE deleted_at IS NULL AND status = 'ready' AND display_metadata_version = 1;
