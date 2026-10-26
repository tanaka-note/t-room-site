-- Folder status reads must not scan the normal authentication audit history.
CREATE INDEX idx_security_backup_status
ON security_audit_events(target_id, occurred_at DESC, event_id DESC)
WHERE target_type = 'backup';
