-- Add asset reporting without creating Identity links or credentials.
-- Preserve existing data, audit totals, indexes and post-0027 Household guards.
CREATE TABLE security_service_links_next (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  service TEXT NOT NULL CHECK (service IN ('cloud', 'diary', 'billing', 'ai', 'downloader', 'downloader2', 'inventory', 'health', 'payments', 'household', 'calendar', 'portfolio')),
  service_account_id TEXT NOT NULL,
  cloud_root_folder_id INTEGER,
  display_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE
);

INSERT INTO security_service_links_next
  (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status, created_at, updated_at)
SELECT id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status, created_at, updated_at
FROM security_service_links;

CREATE TABLE security_handoffs_next (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  cloud_folder_scopes TEXT,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links_next(id),
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id)
);

INSERT INTO security_handoffs_next
  (id, token_hash, identity_id, service_link_id, credential_id, expires_at, consumed_at, created_at, session_epoch, cloud_folder_scopes)
SELECT id, token_hash, identity_id, service_link_id, credential_id, expires_at, consumed_at, created_at, session_epoch, cloud_folder_scopes
FROM security_handoffs;

CREATE TABLE security_tcloud_key_envelopes_next (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  envelope_type TEXT NOT NULL CHECK (envelope_type IN ('admin_private_prf', 'client_private_prf', 'folder_key_rsa')),
  public_key_jwk TEXT,
  encrypted_payload TEXT,
  payload_iv TEXT,
  wrapped_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (credential_id, service_link_id, envelope_type),
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links_next(id) ON DELETE CASCADE
);

INSERT INTO security_tcloud_key_envelopes_next
  (id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk,
   encrypted_payload, payload_iv, wrapped_key, created_at, updated_at)
SELECT id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk,
       encrypted_payload, payload_iv, wrapped_key, created_at, updated_at
FROM security_tcloud_key_envelopes;

CREATE TABLE security_health_grants_next (identity_id TEXT NOT NULL REFERENCES security_identities(id), credential_id TEXT NOT NULL REFERENCES security_credentials(credential_id), service_link_id TEXT NOT NULL REFERENCES security_service_links_next(id), wrapped_key TEXT NOT NULL, PRIMARY KEY(credential_id,service_link_id));
INSERT INTO security_health_grants_next SELECT * FROM security_health_grants;
DROP TABLE security_health_grants;

DROP TABLE security_handoffs;
DROP TABLE security_tcloud_key_envelopes;
DROP TABLE security_service_links;

ALTER TABLE security_service_links_next RENAME TO security_service_links;
ALTER TABLE security_health_grants_next RENAME TO security_health_grants;
ALTER TABLE security_handoffs_next RENAME TO security_handoffs;
ALTER TABLE security_tcloud_key_envelopes_next RENAME TO security_tcloud_key_envelopes;

CREATE INDEX idx_security_service_links_identity
ON security_service_links(identity_id, service, status);
CREATE INDEX idx_security_handoffs_expiry
ON security_handoffs(expires_at, consumed_at);
CREATE UNIQUE INDEX uq_security_service_links_current
ON security_service_links(identity_id, service, service_account_id, COALESCE(cloud_root_folder_id, -1))
WHERE status IN ('pending', 'active');
CREATE UNIQUE INDEX uq_security_service_links_exclusive_current
ON security_service_links(service, service_account_id)
WHERE service IN ('diary', 'billing', 'inventory', 'payments')
  AND status IN ('pending', 'active')
  AND NOT (
    identity_id = 'primary-admin'
    AND service = 'diary'
    AND service_account_id = 'main-user'
  );

CREATE TABLE security_audit_events_next (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  service TEXT NOT NULL CHECK (service IN ('security', 'cloud', 'diary', 'billing', 'ai', 'downloader', 'downloader2', 'inventory', 'health', 'payments', 'household', 'calendar', 'portfolio')),
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'blocked', 'cancelled', 'info')),
  identity_id TEXT,
  service_account_id TEXT,
  role TEXT,
  auth_method TEXT CHECK (auth_method IS NULL OR auth_method IN ('password', 'passkey', 'system')),
  session_id_hash TEXT,
  source_hash TEXT,
  user_agent TEXT,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  service_link_id TEXT,
  service_account_label TEXT
);

INSERT INTO security_audit_events_next
  (event_id, occurred_at, received_at, service, event_type, outcome, identity_id,
   service_account_id, role, auth_method, session_id_hash, source_hash, user_agent,
   target_type, target_id, details_json, service_link_id, service_account_label)
SELECT event_id, occurred_at, received_at, service, event_type, outcome, identity_id,
       service_account_id, role, auth_method, session_id_hash, source_hash, user_agent,
       target_type, target_id, details_json, service_link_id, service_account_label
FROM security_audit_events;

DROP TABLE security_audit_events;
ALTER TABLE security_audit_events_next RENAME TO security_audit_events;
CREATE INDEX idx_security_audit_occurred
ON security_audit_events(occurred_at DESC, event_id);
CREATE INDEX idx_security_audit_filters
ON security_audit_events(service, outcome, auth_method, event_type, occurred_at DESC);
CREATE UNIQUE INDEX uq_security_audit_session_resume_minute
ON security_audit_events(service, session_id_hash, substr(occurred_at, 1, 16))
WHERE event_type = 'session_resume' AND session_id_hash IS NOT NULL;

CREATE TABLE security_active_sessions_next (
  session_id_hash TEXT PRIMARY KEY,
  identity_id TEXT,
  service TEXT NOT NULL CHECK (service IN ('security', 'cloud', 'diary', 'billing', 'ai', 'downloader', 'downloader2', 'inventory', 'health', 'payments', 'household', 'calendar', 'portfolio')),
  service_link_id TEXT,
  service_account_id TEXT,
  credential_id TEXT,
  role TEXT,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'passkey')),
  session_version TEXT NOT NULL,
  passkey_session_epoch INTEGER,
  cloud_folder_scopes TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO security_active_sessions_next
  (session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id,
   role, auth_method, session_version, passkey_session_epoch, cloud_folder_scopes, started_at, last_seen_at,
   expires_at, ended_at, end_reason, created_at, updated_at)
SELECT session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id,
       role, auth_method, session_version, passkey_session_epoch, cloud_folder_scopes, started_at, last_seen_at,
       expires_at, ended_at, end_reason, created_at, updated_at
FROM security_active_sessions;

DROP TABLE security_active_sessions;
ALTER TABLE security_active_sessions_next RENAME TO security_active_sessions;
CREATE INDEX idx_security_active_sessions_identity
ON security_active_sessions(identity_id, ended_at, expires_at);
CREATE INDEX idx_security_active_sessions_service
ON security_active_sessions(service, ended_at, expires_at);


CREATE TRIGGER health_members_only BEFORE INSERT ON security_service_links WHEN NEW.service='health' BEGIN SELECT CASE WHEN NEW.service_account_id!='nobumi' OR NEW.cloud_root_folder_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM security_health_members WHERE identity_id=NEW.identity_id) THEN RAISE(ABORT,'health membership required') END; END;
CREATE TRIGGER health_members_only_update BEFORE UPDATE OF identity_id,service,service_account_id,cloud_root_folder_id ON security_service_links WHEN NEW.service='health' BEGIN SELECT CASE WHEN NEW.service_account_id!='nobumi' OR NEW.cloud_root_folder_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM security_health_members WHERE identity_id=NEW.identity_id) THEN RAISE(ABORT,'health membership required') END; END;
CREATE TRIGGER payments_owner_only BEFORE INSERT ON security_service_links WHEN NEW.service='payments' BEGIN SELECT CASE WHEN NEW.identity_id!='primary-admin' OR NEW.service_account_id!='owner' OR NEW.cloud_root_folder_id IS NOT NULL THEN RAISE(ABORT,'payments owner required') END; END;
CREATE TRIGGER payments_owner_only_update BEFORE UPDATE OF identity_id,service,service_account_id,cloud_root_folder_id ON security_service_links WHEN NEW.service='payments' BEGIN SELECT CASE WHEN NEW.identity_id!='primary-admin' OR NEW.service_account_id!='owner' OR NEW.cloud_root_folder_id IS NOT NULL THEN RAISE(ABORT,'payments owner required') END; END;

-- Preserve the existing derived totals; only recreate their triggers and indexes
-- after rebuilding source tables. Do not backfill the totals a second time.
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

-- 0026_backup_status_index predates this extension. Its table is rebuilt above.
CREATE INDEX idx_security_backup_status
ON security_audit_events(target_id, occurred_at DESC, event_id DESC)
WHERE target_type = 'backup';


CREATE TRIGGER household_account_guard BEFORE INSERT ON security_service_links
WHEN NEW.service='household'
BEGIN
  SELECT CASE WHEN NEW.service_account_id IS NULL
    OR length(NEW.service_account_id) NOT BETWEEN 1 AND 100
    OR NEW.cloud_root_folder_id IS NOT NULL
    OR (NEW.service_account_id='owner' AND NEW.identity_id!='primary-admin')
  THEN RAISE(ABORT,'household account required') END;
END;
CREATE TRIGGER household_account_guard_update
BEFORE UPDATE OF identity_id,service,service_account_id,cloud_root_folder_id ON security_service_links
WHEN NEW.service='household'
BEGIN
  SELECT CASE WHEN NEW.service_account_id IS NULL
    OR length(NEW.service_account_id) NOT BETWEEN 1 AND 100
    OR NEW.cloud_root_folder_id IS NOT NULL
    OR (NEW.service_account_id='owner' AND NEW.identity_id!='primary-admin')
  THEN RAISE(ABORT,'household account required') END;
END;

CREATE UNIQUE INDEX uq_household_identity_account_current ON security_service_links(identity_id, service_account_id) WHERE service='household' AND status IN ('pending','active');

CREATE TRIGGER portfolio_account_guard BEFORE INSERT ON security_service_links
WHEN NEW.service='portfolio' BEGIN
 SELECT CASE WHEN NEW.service_account_id NOT IN ('owner','viewer') OR NEW.cloud_root_folder_id IS NOT NULL OR (NEW.service_account_id='owner' AND NEW.identity_id!='primary-admin') THEN RAISE(ABORT,'portfolio account required') END;
END;
CREATE TRIGGER portfolio_account_guard_update BEFORE UPDATE OF identity_id,service,service_account_id,cloud_root_folder_id ON security_service_links
WHEN NEW.service='portfolio' BEGIN
 SELECT CASE WHEN NEW.service_account_id NOT IN ('owner','viewer') OR NEW.cloud_root_folder_id IS NOT NULL OR (NEW.service_account_id='owner' AND NEW.identity_id!='primary-admin') THEN RAISE(ABORT,'portfolio account required') END;
END;
