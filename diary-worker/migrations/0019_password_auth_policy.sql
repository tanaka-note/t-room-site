-- Schema only. No account is stopped by migration; explicit per-account
-- changes require tools/password-auth.mjs after account/Passkey preflight.
-- No FK: Diary also has static accounts whose credentials remain in Secrets.
CREATE TABLE password_auth_policy (
  service TEXT NOT NULL CHECK (service = 'diary'),
  account_id TEXT NOT NULL,
  password_auth_enabled INTEGER NOT NULL CHECK (password_auth_enabled IN (0, 1)),
  password_session_epoch INTEGER NOT NULL CHECK (password_session_epoch >= 1),
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (service, account_id)
);
CREATE TABLE password_auth_policy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  password_session_epoch INTEGER NOT NULL,
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER password_auth_policy_insert_audit AFTER INSERT ON password_auth_policy BEGIN
  INSERT INTO password_auth_policy_audit (service, account_id, event_type, password_session_epoch, changed_by, reason)
  VALUES (NEW.service, NEW.account_id, CASE NEW.password_auth_enabled WHEN 1 THEN 'password_auth_enabled' ELSE 'password_auth_disabled' END,
    NEW.password_session_epoch, NEW.changed_by, NEW.reason);
END;
CREATE TRIGGER password_auth_policy_update_audit AFTER UPDATE ON password_auth_policy BEGIN
  INSERT INTO password_auth_policy_audit (service, account_id, event_type, password_session_epoch, changed_by, reason)
  VALUES (NEW.service, NEW.account_id, CASE NEW.password_auth_enabled WHEN 1 THEN 'password_auth_enabled' ELSE 'password_auth_disabled' END,
    NEW.password_session_epoch, NEW.changed_by, NEW.reason);
END;

-- Removing or rolling back a policy could resurrect pre-disable cookies.
CREATE TRIGGER password_auth_policy_no_delete BEFORE DELETE ON password_auth_policy BEGIN
  SELECT RAISE(ABORT, 'Password policy rows must be retained');
END;
CREATE TRIGGER password_auth_policy_monotonic BEFORE UPDATE ON password_auth_policy
WHEN NEW.service != OLD.service OR NEW.account_id != OLD.account_id OR NEW.password_session_epoch <= OLD.password_session_epoch BEGIN
  SELECT RAISE(ABORT, 'Password policy identity is immutable and epoch must advance');
END;
