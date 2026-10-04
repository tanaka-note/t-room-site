-- Snapshot approved, credential-ready ordinary folder links. No key material.
-- NULL preserves legacy single-link handoffs and service sessions.
ALTER TABLE security_handoffs ADD COLUMN cloud_folder_scopes TEXT;
ALTER TABLE security_active_sessions ADD COLUMN cloud_folder_scopes TEXT;
