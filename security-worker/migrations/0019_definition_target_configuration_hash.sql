-- Additive: preserve existing pending intents and all monitor history.
-- Store only the SHA-256 of the normalized full expected configuration.
ALTER TABLE security_definition_updates ADD COLUMN pending_target_configuration_hash TEXT;
