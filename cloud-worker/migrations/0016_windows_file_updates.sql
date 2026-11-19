-- Pending transfer state is device-specific and is never automatically restored.
CREATE TABLE cloud_windows_uploads (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES cloud_windows_devices(id) ON DELETE CASCADE,
  body_hash TEXT NOT NULL,
  epoch TEXT NOT NULL,
  file_id INTEGER,
  expected_revision INTEGER,
  upload_id INTEGER NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  folder_id INTEGER NOT NULL,
  ancestors TEXT NOT NULL,
  source_ancestors TEXT,
  archive_json TEXT,
  trash_operation_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT windows_update_transition
    CHECK(state IN ('pending','committing','committed','aborting','aborted')),
  result_revision INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

-- Durable provenance and encrypted restore names belong in data backups.
CREATE TABLE cloud_file_versions (
  file_id INTEGER PRIMARY KEY REFERENCES cloud_files(id) ON DELETE CASCADE,
  source_file_id INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  content_version TEXT NOT NULL CHECK(length(content_version)=64 AND content_version NOT GLOB '*[^0-9a-f]*'),
  restore_metadata TEXT,
  restore_iv TEXT,
  restore_name TEXT,
  restore_display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  restored_at TEXT,
  CHECK((restore_metadata IS NOT NULL AND restore_iv IS NOT NULL AND restore_name IS NULL)
    OR (restore_metadata IS NULL AND restore_iv IS NULL AND restore_name IS NOT NULL))
);
CREATE INDEX cloud_version_content ON cloud_file_versions(content_version);
-- Existing file and folder restore APIs both use this transaction-local hook.
-- The client has already encrypted the distinct restore name with the OLD key.
CREATE TRIGGER cloud_version_restore_name AFTER UPDATE OF deleted_at ON cloud_files
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM cloud_file_versions WHERE file_id=NEW.id AND restored_at IS NULL)
BEGIN
  UPDATE cloud_files SET
    encrypted_metadata=COALESCE((SELECT restore_metadata FROM cloud_file_versions WHERE file_id=NEW.id),encrypted_metadata),
    metadata_iv=COALESCE((SELECT restore_iv FROM cloud_file_versions WHERE file_id=NEW.id),metadata_iv),
    original_name=COALESCE((SELECT restore_name FROM cloud_file_versions WHERE file_id=NEW.id),original_name),
    display_name=CASE WHEN display_metadata_version=1 THEN COALESCE(
      (SELECT restore_display_name FROM cloud_file_versions WHERE file_id=NEW.id),display_name) ELSE display_name END,
    updated_at=CURRENT_TIMESTAMP WHERE id=NEW.id;
  UPDATE cloud_file_versions SET restored_at=CURRENT_TIMESTAMP WHERE file_id=NEW.id;
END;
