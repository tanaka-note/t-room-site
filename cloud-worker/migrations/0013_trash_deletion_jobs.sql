-- Persist the accepted scope; neither a tab nor a session is needed by consumers.
CREATE TABLE cloud_trash_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed')),
  actor_role TEXT NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  total_folders INTEGER NOT NULL DEFAULT 0,
  deleted_files INTEGER NOT NULL DEFAULT 0,
  deleted_folders INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX cloud_trash_jobs_active ON cloud_trash_jobs((1)) WHERE status <> 'completed';
ALTER TABLE cloud_files ADD COLUMN purge_job_id TEXT REFERENCES cloud_trash_jobs(id);
ALTER TABLE cloud_files ADD COLUMN purge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_folders ADD COLUMN purge_job_id TEXT REFERENCES cloud_trash_jobs(id);
CREATE INDEX cloud_files_purge_job ON cloud_files(purge_job_id, purge_attempts, id);
CREATE INDEX cloud_folders_purge_job ON cloud_folders(purge_job_id, id);

-- Close the race between accepting deletion and an already in-flight restore.
CREATE TRIGGER cloud_files_purge_restore_guard BEFORE UPDATE OF deleted_at ON cloud_files
WHEN OLD.purge_job_id IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN SELECT RAISE(ABORT, 'permanent deletion already accepted'); END;
CREATE TRIGGER cloud_folders_purge_restore_guard BEFORE UPDATE OF deleted_at ON cloud_folders
WHEN OLD.purge_job_id IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at
BEGIN SELECT RAISE(ABORT, 'permanent deletion already accepted'); END;
CREATE TRIGGER cloud_files_purge_progress AFTER DELETE ON cloud_files
WHEN OLD.purge_job_id IS NOT NULL
BEGIN
  UPDATE cloud_trash_jobs SET deleted_files = deleted_files + 1 WHERE id = OLD.purge_job_id;
END;
CREATE TRIGGER cloud_folders_purge_progress AFTER DELETE ON cloud_folders
WHEN OLD.purge_job_id IS NOT NULL
BEGIN
  UPDATE cloud_trash_jobs SET deleted_folders = deleted_folders + 1 WHERE id = OLD.purge_job_id;
END;
