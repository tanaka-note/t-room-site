DELETE FROM security_health_grants
WHERE service_link_id IN (SELECT id FROM security_service_links WHERE service = 'health');

DELETE FROM security_handoffs
WHERE service_link_id IN (SELECT id FROM security_service_links WHERE service = 'health');

DELETE FROM security_active_sessions WHERE service = 'health';

DELETE FROM security_service_links WHERE service = 'health';
