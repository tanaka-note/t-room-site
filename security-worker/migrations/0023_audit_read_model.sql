-- Derived JST totals only: no Identity IDs, credentials, secrets, or raw logs.
-- Backfill once; all future inserts/deletes/reclassification update atomically.
CREATE TABLE security_audit_daily (
  day TEXT PRIMARY KEY NOT NULL,
  event_count INTEGER NOT NULL CHECK(event_count >= 0),
  login_success INTEGER NOT NULL CHECK(login_success >= 0),
  login_failure INTEGER NOT NULL CHECK(login_failure >= 0),
  lockouts INTEGER NOT NULL CHECK(lockouts >= 0),
  session_resume INTEGER NOT NULL CHECK(session_resume >= 0),
  critical INTEGER NOT NULL CHECK(critical >= 0)
);

INSERT INTO security_audit_daily(day, event_count, login_success, login_failure, lockouts, session_resume, critical)
SELECT date(occurred_at, '+9 hours'), COUNT(*),
  SUM(CASE WHEN event_type IN ('password_login_success', 'passkey_login_success') AND outcome = 'success' THEN 1 ELSE 0 END),
  SUM(CASE WHEN event_type IN ('password_login_failure', 'passkey_authentication_failure', 'bootstrap_auth_failure') AND outcome = 'failure' THEN 1 ELSE 0 END),
  SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END),
  SUM(CASE WHEN event_type = 'session_resume' THEN 1 ELSE 0 END),
  SUM(CASE WHEN event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END)
FROM security_audit_events WHERE date(occurred_at, '+9 hours') IS NOT NULL
GROUP BY date(occurred_at, '+9 hours');

CREATE TRIGGER security_audit_daily_insert AFTER INSERT ON security_audit_events BEGIN
  INSERT INTO security_audit_daily(day, event_count, login_success, login_failure, lockouts, session_resume, critical)
  SELECT date(NEW.occurred_at, '+9 hours'), 1, CASE WHEN NEW.event_type IN ('password_login_success', 'passkey_login_success') AND NEW.outcome = 'success' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type IN ('password_login_failure', 'passkey_authentication_failure', 'bootstrap_auth_failure') AND NEW.outcome = 'failure' THEN 1 ELSE 0 END,
    CASE WHEN NEW.outcome = 'blocked' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type = 'session_resume' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END
  WHERE date(NEW.occurred_at, '+9 hours') IS NOT NULL
  ON CONFLICT(day) DO UPDATE SET event_count = event_count + 1,
    login_success = login_success + excluded.login_success,
    login_failure = login_failure + excluded.login_failure,
    lockouts = lockouts + excluded.lockouts,
    session_resume = session_resume + excluded.session_resume,
    critical = critical + excluded.critical;
END;

CREATE TRIGGER security_audit_daily_delete AFTER DELETE ON security_audit_events BEGIN
  UPDATE security_audit_daily SET event_count = event_count - 1,
    login_success = login_success - (CASE WHEN OLD.event_type IN ('password_login_success', 'passkey_login_success') AND OLD.outcome = 'success' THEN 1 ELSE 0 END),
    login_failure = login_failure - (CASE WHEN OLD.event_type IN ('password_login_failure', 'passkey_authentication_failure', 'bootstrap_auth_failure') AND OLD.outcome = 'failure' THEN 1 ELSE 0 END),
    lockouts = lockouts - (CASE WHEN OLD.outcome = 'blocked' THEN 1 ELSE 0 END),
    session_resume = session_resume - (CASE WHEN OLD.event_type = 'session_resume' THEN 1 ELSE 0 END),
    critical = critical - (CASE WHEN OLD.event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END)
  WHERE day = date(OLD.occurred_at, '+9 hours');
  DELETE FROM security_audit_daily WHERE day = date(OLD.occurred_at, '+9 hours') AND event_count = 0;
END;

CREATE TRIGGER security_audit_daily_update AFTER UPDATE OF occurred_at, event_type, outcome ON security_audit_events BEGIN
  UPDATE security_audit_daily SET event_count = event_count - 1,
    login_success = login_success - (CASE WHEN OLD.event_type IN ('password_login_success', 'passkey_login_success') AND OLD.outcome = 'success' THEN 1 ELSE 0 END),
    login_failure = login_failure - (CASE WHEN OLD.event_type IN ('password_login_failure', 'passkey_authentication_failure', 'bootstrap_auth_failure') AND OLD.outcome = 'failure' THEN 1 ELSE 0 END),
    lockouts = lockouts - (CASE WHEN OLD.outcome = 'blocked' THEN 1 ELSE 0 END),
    session_resume = session_resume - (CASE WHEN OLD.event_type = 'session_resume' THEN 1 ELSE 0 END),
    critical = critical - (CASE WHEN OLD.event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END)
  WHERE day = date(OLD.occurred_at, '+9 hours');
  DELETE FROM security_audit_daily WHERE day = date(OLD.occurred_at, '+9 hours') AND event_count = 0;
  INSERT INTO security_audit_daily(day, event_count, login_success, login_failure, lockouts, session_resume, critical)
  SELECT date(NEW.occurred_at, '+9 hours'), 1, CASE WHEN NEW.event_type IN ('password_login_success', 'passkey_login_success') AND NEW.outcome = 'success' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type IN ('password_login_failure', 'passkey_authentication_failure', 'bootstrap_auth_failure') AND NEW.outcome = 'failure' THEN 1 ELSE 0 END,
    CASE WHEN NEW.outcome = 'blocked' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type = 'session_resume' THEN 1 ELSE 0 END,
    CASE WHEN NEW.event_type IN ('credential_compromise', 'admin_access') THEN 1 ELSE 0 END
  WHERE date(NEW.occurred_at, '+9 hours') IS NOT NULL
  ON CONFLICT(day) DO UPDATE SET event_count = event_count + 1,
    login_success = login_success + excluded.login_success,
    login_failure = login_failure + excluded.login_failure,
    lockouts = lockouts + excluded.lockouts,
    session_resume = session_resume + excluded.session_resume,
    critical = critical + excluded.critical;
END;

-- Cursor order and common filters must seek without scanning earlier history.
CREATE INDEX idx_security_audit_identity_page ON security_audit_events(identity_id, occurred_at DESC, event_id);
CREATE INDEX idx_security_audit_service_page ON security_audit_events(service, occurred_at DESC, event_id);
CREATE INDEX idx_security_audit_password_page ON security_audit_events(occurred_at DESC,event_id) WHERE event_type IN ('password_login_success', 'password_login_failure', 'password_login_submit', 'password_login_client_failure', 'bootstrap_auth_success', 'bootstrap_auth_failure', 'bootstrap_login_blocked', 'login_success', 'login_failure', 'login_blocked', 'login_locked') AND auth_method = 'password' AND outcome IN ('success', 'failure', 'blocked');
CREATE INDEX idx_security_audit_passkey_page ON security_audit_events(occurred_at DESC,event_id) WHERE event_type IN ('passkey_login_success', 'passkey_authentication_success', 'passkey_authentication_failure', 'login_success', 'login_failure', 'login_blocked', 'login_locked') AND auth_method = 'passkey' AND outcome IN ('success', 'failure', 'blocked');
CREATE INDEX idx_security_audit_attention_page ON security_audit_events(occurred_at DESC,event_id) WHERE event_type IN ('password_login_success', 'password_login_failure', 'password_login_submit', 'password_login_client_failure', 'bootstrap_auth_success', 'bootstrap_auth_failure', 'bootstrap_login_blocked', 'login_success', 'login_failure', 'login_blocked', 'login_locked', 'passkey_login_success', 'passkey_authentication_success', 'passkey_authentication_failure') AND outcome IN ('failure', 'blocked');
-- The overview queries all current sessions, not an individual service/Identity.
CREATE INDEX idx_security_sessions_current ON security_active_sessions(expires_at) WHERE ended_at IS NULL;
