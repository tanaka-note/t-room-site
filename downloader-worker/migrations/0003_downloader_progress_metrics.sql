PRAGMA foreign_keys = ON;

ALTER TABLE downloader_jobs ADD COLUMN progress_stage TEXT CHECK (
  progress_stage IS NULL OR progress_stage IN (
    'starting', 'downloading', 'validating', 'processing',
    'scanning', 'saving', 'finalizing'
  )
);
ALTER TABLE downloader_jobs ADD COLUMN container_health_ms INTEGER CHECK (container_health_ms IS NULL OR container_health_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN download_ms INTEGER CHECK (download_ms IS NULL OR download_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN validation_ms INTEGER CHECK (validation_ms IS NULL OR validation_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN processing_ms INTEGER CHECK (processing_ms IS NULL OR processing_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN security_scan_ms INTEGER CHECK (security_scan_ms IS NULL OR security_scan_ms >= 0);
ALTER TABLE downloader_jobs ADD COLUMN upload_ms INTEGER CHECK (upload_ms IS NULL OR upload_ms >= 0);
