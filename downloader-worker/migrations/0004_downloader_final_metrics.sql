-- Additive upgrade: do not infer/backfill unknown historical final metrics.
-- Legacy memory/disk rows (which included a fixed 120s) remain as history.
ALTER TABLE downloader_jobs ADD COLUMN usage_day_jst TEXT;
ALTER TABLE downloader_jobs ADD COLUMN usage_identity_id TEXT;
ALTER TABLE downloader_jobs ADD COLUMN metrics_token TEXT;
ALTER TABLE downloader_jobs ADD COLUMN metrics_finalized_at TEXT;
ALTER TABLE downloader_jobs ADD COLUMN metrics_cpu_scope TEXT;

DROP TRIGGER downloader_usage_processing_succeeded;
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
