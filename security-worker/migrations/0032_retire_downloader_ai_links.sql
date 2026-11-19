-- Existing invitations encode an exact set of service links. Revoke affected
-- invitations so they can be reissued for the remaining services.
UPDATE security_invitations SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
WHERE status = 'active'
  AND identity_id IN (SELECT identity_id FROM security_service_links
    WHERE service IN ('downloader', 'downloader2', 'ai'));

DELETE FROM security_challenges WHERE service IN ('downloader', 'downloader2', 'ai');
DELETE FROM security_handoffs
WHERE service_link_id IN (SELECT id FROM security_service_links
  WHERE service IN ('downloader', 'downloader2', 'ai'));

DELETE FROM security_active_sessions WHERE service IN ('downloader', 'downloader2', 'ai');
DELETE FROM security_service_links WHERE service IN ('downloader', 'downloader2', 'ai');
