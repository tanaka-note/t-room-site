PRAGMA foreign_keys = ON;

ALTER TABLE downloader_jobs ADD COLUMN source_bytes INTEGER CHECK (source_bytes IS NULL OR source_bytes >= 0);
ALTER TABLE downloader_jobs ADD COLUMN container_wall_ms INTEGER CHECK (container_wall_ms IS NULL OR container_wall_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN container_cpu_ms INTEGER CHECK (container_cpu_ms IS NULL OR container_cpu_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN container_peak_rss_bytes INTEGER CHECK (container_peak_rss_bytes IS NULL OR container_peak_rss_bytes >= 0);
ALTER TABLE downloader_jobs ADD COLUMN container_work_bytes INTEGER CHECK (container_work_bytes IS NULL OR container_work_bytes >= 0);
ALTER TABLE downloader_jobs ADD COLUMN failure_category TEXT;

CREATE TABLE downloader_usage_daily (
  day_jst TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  value_sum INTEGER NOT NULL DEFAULT 0 CHECK (value_sum >= 0),
  value_max INTEGER NOT NULL DEFAULT 0 CHECK (value_max >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day_jst, identity_id, metric, dimension)
) WITHOUT ROWID;

CREATE INDEX idx_downloader_usage_period
ON downloader_usage_daily(day_jst, metric, dimension);

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

CREATE INDEX idx_downloader_delivery_cleanup
ON downloader_file_delivery_attempts(created_at);

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(created_at, '+9 hours'), identity_id, 'request', 'analyze', COUNT(*)
FROM downloader_jobs
GROUP BY date(created_at, '+9 hours'), identity_id;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(queued_at, '+9 hours'), identity_id, 'request', 'download', COUNT(*)
FROM downloader_jobs
WHERE queued_at IS NOT NULL
GROUP BY date(queued_at, '+9 hours'), identity_id;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(downloaded_at, '+9 hours'), identity_id, 'result', 'success', COUNT(*)
FROM downloader_jobs
WHERE downloaded_at IS NOT NULL
GROUP BY date(downloaded_at, '+9 hours'), identity_id;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(downloaded_at, '+9 hours'), identity_id, 'normalization', COALESCE(normalization_mode, 'UNKNOWN'), COUNT(*)
FROM downloader_jobs
WHERE downloaded_at IS NOT NULL
GROUP BY date(downloaded_at, '+9 hours'), identity_id, COALESCE(normalization_mode, 'UNKNOWN');

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, byte_count)
SELECT date(downloaded_at, '+9 hours'), identity_id, 'bytes', 'r2_stored', COALESCE(SUM(actual_size), 0)
FROM downloader_jobs
WHERE downloaded_at IS NOT NULL AND actual_size IS NOT NULL
GROUP BY date(downloaded_at, '+9 hours'), identity_id;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(downloaded_at, '+9 hours'), identity_id, 'platform', 'r2_class_a', COUNT(*)
FROM downloader_jobs
WHERE downloaded_at IS NOT NULL
GROUP BY date(downloaded_at, '+9 hours'), identity_id;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(updated_at, '+9 hours'), identity_id, 'outcome', status, COUNT(*)
FROM downloader_jobs
WHERE status IN ('failed', 'rejected')
GROUP BY date(updated_at, '+9 hours'), identity_id, status;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(updated_at, '+9 hours'), identity_id, 'security',
  CASE WHEN status = 'rejected' THEN 'other_reject' ELSE 'other_failed' END, COUNT(*)
FROM downloader_jobs
WHERE status IN ('failed', 'rejected')
GROUP BY date(updated_at, '+9 hours'), identity_id, status;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, event_count)
SELECT date(deleted_at, '+9 hours'), identity_id, 'lifecycle', status, COUNT(*)
FROM downloader_jobs
WHERE deleted_at IS NOT NULL AND status IN ('deleted', 'expired')
GROUP BY date(deleted_at, '+9 hours'), identity_id, status;

INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_sum)
SELECT date(deleted_at, '+9 hours'), identity_id, 'resource', 'r2_storage_byte_seconds',
  COALESCE(SUM(actual_size * MAX(0, strftime('%s', deleted_at) - strftime('%s', downloaded_at))), 0)
FROM downloader_jobs
WHERE deleted_at IS NOT NULL AND downloaded_at IS NOT NULL AND actual_size IS NOT NULL
GROUP BY date(deleted_at, '+9 hours'), identity_id;

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

CREATE TRIGGER downloader_usage_processing_succeeded
AFTER UPDATE OF status ON downloader_jobs
WHEN OLD.status != 'ready' AND NEW.status = 'ready'
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

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_cpu_ms', COALESCE(NEW.container_cpu_ms, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_wall_ms', COALESCE(NEW.container_wall_ms, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_memory_gib_seconds', (COALESCE(NEW.container_wall_ms, 0) / 1000 + 120) * 6)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_sum)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_disk_gb_seconds', (COALESCE(NEW.container_wall_ms, 0) / 1000 + 120) * 12)
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_sum = value_sum + excluded.value_sum, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, byte_count)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_network_tx', COALESCE(NEW.actual_size, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET byte_count = byte_count + excluded.byte_count, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_max)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_peak_rss', COALESCE(NEW.container_peak_rss_bytes, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_max = MAX(value_max, excluded.value_max), updated_at = CURRENT_TIMESTAMP;

  INSERT INTO downloader_usage_daily (day_jst, identity_id, metric, dimension, value_max)
  VALUES (date(COALESCE(NEW.downloaded_at, CURRENT_TIMESTAMP), '+9 hours'), NEW.identity_id, 'resource', 'container_peak_work', COALESCE(NEW.container_work_bytes, 0))
  ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET value_max = MAX(value_max, excluded.value_max), updated_at = CURRENT_TIMESTAMP;
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
