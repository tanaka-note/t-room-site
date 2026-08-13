CREATE TABLE IF NOT EXISTS cloud_usage_summary (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_file_count INTEGER NOT NULL DEFAULT 0,
  active_bytes INTEGER NOT NULL DEFAULT 0,
  trash_file_count INTEGER NOT NULL DEFAULT 0,
  trash_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO cloud_usage_summary
  (id, active_file_count, active_bytes, trash_file_count, trash_bytes, updated_at)
SELECT 1,
  COALESCE(SUM(CASE WHEN status = 'ready' AND deleted_at IS NULL THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN status = 'ready' AND deleted_at IS NULL THEN size_bytes ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN status = 'ready' AND deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0),
  COALESCE(SUM(CASE WHEN status = 'ready' AND deleted_at IS NOT NULL THEN size_bytes ELSE 0 END), 0),
  CURRENT_TIMESTAMP
FROM cloud_files;

CREATE TRIGGER IF NOT EXISTS cloud_usage_files_insert
AFTER INSERT ON cloud_files
BEGIN
  UPDATE cloud_usage_summary SET
    active_file_count = active_file_count + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NULL THEN 1 ELSE 0 END,
    active_bytes = active_bytes + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NULL THEN NEW.size_bytes ELSE 0 END,
    trash_file_count = trash_file_count + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NOT NULL THEN 1 ELSE 0 END,
    trash_bytes = trash_bytes + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NOT NULL THEN NEW.size_bytes ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS cloud_usage_files_update
AFTER UPDATE OF status, deleted_at, size_bytes ON cloud_files
BEGIN
  UPDATE cloud_usage_summary SET
    active_file_count = active_file_count
      - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NULL THEN 1 ELSE 0 END
      + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NULL THEN 1 ELSE 0 END,
    active_bytes = active_bytes
      - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NULL THEN OLD.size_bytes ELSE 0 END
      + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NULL THEN NEW.size_bytes ELSE 0 END,
    trash_file_count = trash_file_count
      - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NOT NULL THEN 1 ELSE 0 END,
    trash_bytes = trash_bytes
      - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NOT NULL THEN OLD.size_bytes ELSE 0 END
      + CASE WHEN NEW.status = 'ready' AND NEW.deleted_at IS NOT NULL THEN NEW.size_bytes ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS cloud_usage_files_delete
AFTER DELETE ON cloud_files
BEGIN
  UPDATE cloud_usage_summary SET
    active_file_count = active_file_count - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NULL THEN 1 ELSE 0 END,
    active_bytes = active_bytes - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NULL THEN OLD.size_bytes ELSE 0 END,
    trash_file_count = trash_file_count - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NOT NULL THEN 1 ELSE 0 END,
    trash_bytes = trash_bytes - CASE WHEN OLD.status = 'ready' AND OLD.deleted_at IS NOT NULL THEN OLD.size_bytes ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;
