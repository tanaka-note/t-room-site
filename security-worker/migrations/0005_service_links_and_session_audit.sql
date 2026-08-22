ALTER TABLE security_identities
ADD COLUMN last_seen_at TEXT;

ALTER TABLE security_audit_events
ADD COLUMN service_link_id TEXT;

ALTER TABLE security_audit_events
ADD COLUMN service_account_label TEXT;

-- Diary and Billing accounts are person-specific. A current account link can
-- belong to only one Identity, while disabled rows remain as immutable audit
-- history. T-Cloud folder membership is intentionally shareable.
CREATE UNIQUE INDEX uq_security_service_links_exclusive_current
ON security_service_links(service, service_account_id)
WHERE service IN ('diary', 'billing')
  AND status IN ('pending', 'active');

-- App startup may probe the session endpoint more than once. Store at most one
-- resume event for the same service/session in an UTC minute without retaining
-- the raw session identifier.
CREATE UNIQUE INDEX uq_security_audit_session_resume_minute
ON security_audit_events(service, session_id_hash, substr(occurred_at, 1, 16))
WHERE event_type = 'session_resume'
  AND session_id_hash IS NOT NULL;
