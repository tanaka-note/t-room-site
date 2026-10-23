-- Failed scopes remain locked, but do not occupy the active execution slot.
DROP INDEX cloud_trash_jobs_active;
CREATE UNIQUE INDEX cloud_trash_jobs_active ON cloud_trash_jobs((1)) WHERE status IN ('queued', 'running');
ALTER TABLE cloud_trash_jobs ADD COLUMN dispatch_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_files ADD COLUMN purge_error TEXT;
CREATE INDEX cloud_files_thumbnail_key ON cloud_files(thumbnail_key);
CREATE INDEX cloud_files_display_thumbnail_key ON cloud_files(display_thumbnail_key);
-- Once accepted, a row cannot point a consumer at a different external object.
CREATE TRIGGER cloud_files_purge_identity_guard
BEFORE UPDATE OF object_key, thumbnail_key, display_thumbnail_key, stream_uid ON cloud_files
WHEN OLD.purge_job_id IS NOT NULL AND (
  NEW.object_key IS NOT OLD.object_key OR NEW.thumbnail_key IS NOT OLD.thumbnail_key
  OR NEW.display_thumbnail_key IS NOT OLD.display_thumbnail_key OR NEW.stream_uid IS NOT OLD.stream_uid)
BEGIN SELECT RAISE(ABORT, 'permanent deletion already accepted'); END;
