-- Rebuild the status CHECK without dropping job, delivery or aggregate history.
-- Wrangler applies this migration atomically. Remove the child table before the
-- parent to avoid ON DELETE CASCADE; restore data before restoring usage triggers.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE downloader_jobs_cancel_migration (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'analyzing', 'analyzed', 'queued', 'processing', 'ready',
    'rejected', 'failed', 'expired', 'deleted', 'cancelled'
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, source_bytes INTEGER CHECK (source_bytes IS NULL OR source_bytes >= 0), container_wall_ms INTEGER CHECK (container_wall_ms IS NULL OR container_wall_ms >= 0), container_cpu_ms INTEGER CHECK (container_cpu_ms IS NULL OR container_cpu_ms >= 0), container_peak_rss_bytes INTEGER CHECK (container_peak_rss_bytes IS NULL OR container_peak_rss_bytes >= 0), container_work_bytes INTEGER CHECK (container_work_bytes IS NULL OR container_work_bytes >= 0), failure_category TEXT, progress_stage TEXT CHECK (
  progress_stage IS NULL OR progress_stage IN (
    'starting', 'downloading', 'validating', 'processing',
    'scanning', 'saving', 'finalizing'
  )
), container_health_ms INTEGER CHECK (container_health_ms IS NULL OR container_health_ms >= 0), download_ms INTEGER CHECK (download_ms IS NULL OR download_ms >= 0), validation_ms INTEGER CHECK (validation_ms IS NULL OR validation_ms >= 0), processing_ms INTEGER CHECK (processing_ms IS NULL OR processing_ms >= 0), security_scan_ms INTEGER CHECK (security_scan_ms IS NULL OR security_scan_ms >= 0), upload_ms INTEGER CHECK (upload_ms IS NULL OR upload_ms >= 0), usage_day_jst TEXT, usage_identity_id TEXT, metrics_token TEXT, metrics_finalized_at TEXT, metrics_cpu_scope TEXT,
  UNIQUE (identity_id, client_request_id)
);
ALTER TABLE downloader_jobs_cancel_migration ADD COLUMN cancelled_at TEXT;
ALTER TABLE downloader_jobs_cancel_migration ADD COLUMN cancel_stop_completed_at TEXT;
INSERT INTO downloader_jobs_cancel_migration (id, identity_id, service_link_id, client_request_id, status, source_hostname, source_path_hint, url_hash, extractor, media_type, delivery_type, normalization_mode, selected_media_id, expected_size, actual_size, mime_type, sha256, safe_filename, object_key, analysis_json, error_type, error_reason, created_at, analyzed_at, queued_at, processing_at, processing_token, processing_lease_expires_at, downloaded_at, expires_at, deleted_at, updated_at, source_bytes, container_wall_ms, container_cpu_ms, container_peak_rss_bytes, container_work_bytes, failure_category, progress_stage, container_health_ms, download_ms, validation_ms, processing_ms, security_scan_ms, upload_ms, usage_day_jst, usage_identity_id, metrics_token, metrics_finalized_at, metrics_cpu_scope) SELECT id, identity_id, service_link_id, client_request_id, status, source_hostname, source_path_hint, url_hash, extractor, media_type, delivery_type, normalization_mode, selected_media_id, expected_size, actual_size, mime_type, sha256, safe_filename, object_key, analysis_json, error_type, error_reason, created_at, analyzed_at, queued_at, processing_at, processing_token, processing_lease_expires_at, downloaded_at, expires_at, deleted_at, updated_at, source_bytes, container_wall_ms, container_cpu_ms, container_peak_rss_bytes, container_work_bytes, failure_category, progress_stage, container_health_ms, download_ms, validation_ms, processing_ms, security_scan_ms, upload_ms, usage_day_jst, usage_identity_id, metrics_token, metrics_finalized_at, metrics_cpu_scope FROM downloader_jobs;

CREATE TABLE downloader_delivery_cancel_backup AS SELECT * FROM downloader_file_delivery_attempts;
DROP TABLE downloader_file_delivery_attempts;
DROP TABLE downloader_jobs;
ALTER TABLE downloader_jobs_cancel_migration RENAME TO downloader_jobs;

CREATE TABLE downloader_file_delivery_attempts (
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  day_jst TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, attempt_id),
  FOREIGN KEY (job_id) REFERENCES downloader_jobs(id) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO downloader_file_delivery_attempts SELECT * FROM downloader_delivery_cancel_backup;
DROP TABLE downloader_delivery_cancel_backup;

CREATE INDEX idx_downloader_jobs_owner
ON downloader_jobs(identity_id, created_at DESC);

CREATE INDEX idx_downloader_jobs_cleanup
ON downloader_jobs(status, expires_at);

CREATE INDEX idx_downloader_jobs_hostname
ON downloader_jobs(source_hostname, created_at DESC);

CREATE INDEX idx_downloader_delivery_cleanup
ON downloader_file_delivery_attempts(created_at);

CREATE TRIGGER downloader_usage_job_created
AFTER INSERT ON downloader_jobs
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(NEW.created_at, '+9 hours'), NEW.identity_id, 'request', 'analyze', 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET
    event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_download_requested
AFTER UPDATE OF status ON downloader_jobs
WHEN OLD.status = 'analyzed' AND NEW.status = 'queued'
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(COALESCE(NEW.queued_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'request', 'download', 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET
    event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_terminal_outcome
AFTER UPDATE OF status ON downloader_jobs
WHEN OLD.status != NEW.status AND NEW.status IN ('failed', 'rejected')
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(NEW.updated_at, '+9 hours'), NEW.identity_id, 'outcome', NEW.status, 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(NEW.updated_at, '+9 hours'), NEW.identity_id, 'security', COALESCE(NEW.failure_category, CASE WHEN NEW.status = 'rejected' THEN 'other_reject' ELSE 'other_failed' END), 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_job_retired
AFTER UPDATE OF status ON downloader_jobs
WHEN OLD.status != NEW.status AND NEW.status IN ('deleted', 'expired')
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(COALESCE(NEW.deleted_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'lifecycle', NEW.status, 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_sum)
  VALUES (date(COALESCE(NEW.deleted_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'r2_storage_byte_seconds',
    CASE WHEN OLD.status NOT IN ('deleted', 'expired') AND NEW.actual_size IS NOT NULL AND NEW.downloaded_at IS NOT NULL
      THEN NEW.actual_size * MAX(0, strftime('%s', COALESCE(NEW.deleted_at, CURRENT_TIMESTAMP)) - strftime('%s', NEW.downloaded_at)) ELSE 0 END)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_file_delivery
AFTER INSERT ON downloader_file_delivery_attempts
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count, byte_count)
  VALUES (NEW.day_jst, NEW.identity_id, 'delivery', 'started', 1, NEW.byte_count)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET
    event_count = event_count + 1, byte_count = byte_count + excluded.byte_count, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_processing_succeeded
AFTER UPDATE OF status ON downloader_jobs
WHEN OLD.downloaded_at IS NULL AND NEW.status = 'ready'
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'result', 'success', 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'normalization', COALESCE(NEW.normalization_mode, 'UNKNOWN'), 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, byte_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'bytes', 'source', COALESCE(NEW.source_bytes, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET byte_count = byte_count + excluded.byte_count, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, byte_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'bytes', 'r2_stored', COALESCE(NEW.actual_size, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET byte_count = byte_count + excluded.byte_count, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_cpu_ms', NEW.container_cpu_ms IS NOT NULL, COALESCE(NEW.container_cpu_ms, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + excluded.event_count, value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_wall_ms', NEW.container_wall_ms IS NOT NULL, COALESCE(NEW.container_wall_ms, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + excluded.event_count, value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_observed_memory_gib_seconds', NEW.container_wall_ms IS NOT NULL, (COALESCE(NEW.container_wall_ms, 0) / 1000.0) * 6)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + excluded.event_count, value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_observed_disk_gb_seconds', NEW.container_wall_ms IS NOT NULL, (COALESCE(NEW.container_wall_ms, 0) / 1000.0) * 12)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + excluded.event_count, value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, byte_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_network_tx', COALESCE(NEW.actual_size, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET byte_count = byte_count + excluded.byte_count, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_max)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_peak_rss', COALESCE(NEW.container_peak_rss_bytes, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_max = MAX(value_max, excluded.value_max), updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_max)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_peak_work', COALESCE(NEW.container_work_bytes, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_max = MAX(value_max, excluded.value_max), updated_at = CURRENT_TIMESTAMP;
  UPDATE downloader_jobs SET usage_day_jst = date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'),
    usage_identity_id = NEW.identity_id WHERE id = NEW.id;
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'measurement', 'container_provisional', 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_metrics_finalized
AFTER UPDATE OF metrics_finalized_at ON downloader_jobs
WHEN OLD.metrics_finalized_at IS NULL AND NEW.metrics_finalized_at IS NOT NULL
  AND OLD.usage_day_jst IS NOT NULL AND OLD.usage_identity_id IS NOT NULL
BEGIN
  UPDATE downloader_usage_daily SET
    value_sum = value_sum + (COALESCE(NEW.container_cpu_ms, 0) - COALESCE(OLD.container_cpu_ms, 0)) * 1,
    event_count = event_count + (OLD.container_cpu_ms IS NULL AND NEW.container_cpu_ms IS NOT NULL), updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'resource' AND dimension = 'container_cpu_ms';

  UPDATE downloader_usage_daily SET
    value_sum = value_sum + (COALESCE(NEW.container_wall_ms, 0) - COALESCE(OLD.container_wall_ms, 0)) * 1,
    event_count = event_count + (OLD.container_wall_ms IS NULL AND NEW.container_wall_ms IS NOT NULL), updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'resource' AND dimension = 'container_wall_ms';

  UPDATE downloader_usage_daily SET
    value_sum = value_sum + (COALESCE(NEW.container_wall_ms, 0) - COALESCE(OLD.container_wall_ms, 0)) * 0.006,
    event_count = event_count + (OLD.container_wall_ms IS NULL AND NEW.container_wall_ms IS NOT NULL), updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'resource' AND dimension = 'container_observed_memory_gib_seconds';

  UPDATE downloader_usage_daily SET
    value_sum = value_sum + (COALESCE(NEW.container_wall_ms, 0) - COALESCE(OLD.container_wall_ms, 0)) * 0.012,
    event_count = event_count + (OLD.container_wall_ms IS NULL AND NEW.container_wall_ms IS NOT NULL), updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'resource' AND dimension = 'container_observed_disk_gb_seconds';

  UPDATE downloader_usage_daily SET value_max = MAX(value_max, COALESCE(NEW.container_peak_rss_bytes, 0)), updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'resource' AND dimension = 'container_peak_rss';

  UPDATE downloader_usage_daily SET value_max = MAX(value_max, COALESCE(NEW.container_work_bytes, 0)), updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'resource' AND dimension = 'container_peak_work';

  UPDATE downloader_usage_daily SET event_count = event_count - 1, updated_at = CURRENT_TIMESTAMP
  WHERE day_jst = OLD.usage_day_jst AND identity_id = OLD.usage_identity_id
    AND metric = 'measurement' AND dimension = 'container_provisional';
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (OLD.usage_day_jst, OLD.usage_identity_id, 'measurement', 'container_finalized', 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER downloader_usage_analysis_cancelled
AFTER UPDATE OF status ON downloader_jobs
WHEN OLD.status != NEW.status AND NEW.status = 'cancelled'
BEGIN
  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
  VALUES (date(NEW.cancelled_at, '+9 hours'), NEW.identity_id, 'lifecycle', 'cancelled', 1)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET event_count = event_count + 1, updated_at = CURRENT_TIMESTAMP;
END;

PRAGMA defer_foreign_keys = OFF;
