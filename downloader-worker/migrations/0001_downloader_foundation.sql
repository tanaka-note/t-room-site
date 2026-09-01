PRAGMA foreign_keys = ON;

CREATE TABLE downloader_jobs (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'analyzing', 'analyzed', 'queued', 'processing', 'ready',
    'rejected', 'failed', 'expired', 'deleted'
  )),
  source_hostname TEXT NOT NULL,
  source_path_hint TEXT,
  url_hash TEXT NOT NULL,
  extractor TEXT,
  media_type TEXT,
  delivery_type TEXT,
  normalization_mode TEXT,
  selected_media_id TEXT,
  expected_size INTEGER,
  actual_size INTEGER,
  mime_type TEXT,
  sha256 TEXT,
  safe_filename TEXT,
  object_key TEXT,
  analysis_json TEXT NOT NULL DEFAULT '{}',
  error_type TEXT,
  error_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  analyzed_at TEXT,
  queued_at TEXT,
  processing_at TEXT,
  processing_token TEXT,
  processing_lease_expires_at INTEGER,
  downloaded_at TEXT,
  expires_at INTEGER,
  deleted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (identity_id, client_request_id)
);

CREATE INDEX idx_downloader_jobs_owner
ON downloader_jobs(identity_id, created_at DESC);

CREATE INDEX idx_downloader_jobs_cleanup
ON downloader_jobs(status, expires_at);

CREATE INDEX idx_downloader_jobs_hostname
ON downloader_jobs(source_hostname, created_at DESC);

CREATE TABLE downloader_rate_events (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  source_hostname TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('analyze', 'download')),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_downloader_rate_identity
ON downloader_rate_events(identity_id, action, occurred_at);

CREATE INDEX idx_downloader_rate_hostname
ON downloader_rate_events(source_hostname, action, occurred_at);
