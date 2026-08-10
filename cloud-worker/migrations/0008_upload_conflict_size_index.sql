CREATE INDEX IF NOT EXISTS cloud_files_size_ready_idx
  ON cloud_files(size_bytes, id)
  WHERE deleted_at IS NULL AND status = 'ready';
