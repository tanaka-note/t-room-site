-- Do not infer hourly execution from the legacy daily/shared heartbeat.
ALTER TABLE security_definition_updates ADD COLUMN hourly_monitor_started_at INTEGER;
ALTER TABLE security_definition_updates ADD COLUMN hourly_monitor_checked_at INTEGER;
