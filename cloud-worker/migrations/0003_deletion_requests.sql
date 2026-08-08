CREATE TABLE IF NOT EXISTS cloud_deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER REFERENCES cloud_files(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('subadmin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  approved_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_deletion_requests_pending_file_idx
  ON cloud_deletion_requests(file_id)
  WHERE status = 'pending' AND file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cloud_deletion_requests_status_idx
  ON cloud_deletion_requests(status, requested_at DESC);
