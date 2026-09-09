-- started_at is NOT NULL. An empty string means unknown (API: null), never
-- the time of this migration or a session resume. Keep all valid starts intact.
-- Only an unambiguous successful login for this exact session/identity/service
-- and auth method is evidence. Conflicting or missing evidence stays unknown.
UPDATE security_active_sessions AS session
SET started_at = COALESCE((
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(event.occurred_at))
  FROM security_audit_events AS event
  WHERE event.session_id_hash = session.session_id_hash
    AND event.identity_id = session.identity_id
    AND event.service = session.service
    AND event.auth_method = session.auth_method
    AND event.event_type = CASE session.auth_method
      WHEN 'password' THEN 'password_login_success' ELSE 'passkey_login_success' END
    AND event.outcome = 'success'
  HAVING COUNT(*) > 0
    AND COUNT(DISTINCT julianday(event.occurred_at)) = 1
    AND COUNT(julianday(event.occurred_at)) = COUNT(*)
    AND MIN(julianday(event.occurred_at)) > 2440587.5
    AND MAX(julianday(event.occurred_at)) <= julianday(session.last_seen_at)
    AND MAX(julianday(event.occurred_at)) < julianday(session.expires_at, 'unixepoch')
    AND (session.ended_at IS NULL OR MAX(julianday(event.occurred_at)) <= julianday(session.ended_at))
), '')
WHERE COALESCE(julianday(session.started_at), 0) <= 2440587.5;
