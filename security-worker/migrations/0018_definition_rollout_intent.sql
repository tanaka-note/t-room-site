-- Additive: the last verified deployment and monitor history remain authoritative.
ALTER TABLE security_definition_updates ADD COLUMN pending_image TEXT;
ALTER TABLE security_definition_updates ADD COLUMN pending_previous_image TEXT;
ALTER TABLE security_definition_updates ADD COLUMN pending_source_image TEXT;
ALTER TABLE security_definition_updates ADD COLUMN pending_definition_unix INTEGER;
ALTER TABLE security_definition_updates ADD COLUMN pending_verified_at INTEGER;
ALTER TABLE security_definition_updates ADD COLUMN pending_started_at INTEGER;
ALTER TABLE security_definition_updates ADD COLUMN pending_rollout_id TEXT;
ALTER TABLE security_definition_updates ADD COLUMN pending_state TEXT;
ALTER TABLE security_definition_updates ADD COLUMN pending_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE security_definition_updates ADD COLUMN pending_reconciliations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE security_definition_updates ADD COLUMN pending_version INTEGER;
ALTER TABLE security_definition_updates ADD COLUMN pending_configuration_hash TEXT;
ALTER TABLE security_definition_updates ADD COLUMN pending_rollout_ids TEXT;
