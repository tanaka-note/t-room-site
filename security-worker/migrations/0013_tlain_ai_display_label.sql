-- Update only the built-in AI account label. Keep link IDs, status, permissions,
-- sessions, credentials, encrypted key envelopes, and audit snapshots intact.
UPDATE security_service_links
SET display_label = 'AI Chat By T-lain'
WHERE service = 'ai'
  AND service_account_id = 'owner'
  AND display_label = 'AI Chat By T-ROOM';
