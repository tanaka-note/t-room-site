CREATE TABLE security_definition_updates (
  service TEXT PRIMARY KEY CHECK (service = 'downloader'),
  image TEXT,
  previous_image TEXT,
  source_image TEXT,
  definition_unix INTEGER,
  verified_at INTEGER,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_result TEXT NOT NULL DEFAULT 'unknown',
  failure_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  lease_until INTEGER,
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  monitor_checked_at INTEGER,
  image_checked_at INTEGER,
  deployment_matches INTEGER NOT NULL DEFAULT 0,
  incident TEXT NOT NULL DEFAULT 'unknown',
  incident_changed_at INTEGER
);
INSERT INTO security_definition_updates(service) VALUES ('downloader');

CREATE TABLE security_definition_events (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  UNIQUE(occurred_at, state)
);
