-- Additive migration: existing accounts/entries/requests are left intact.
CREATE TABLE payments_monthly_marks (
  entry_id TEXT NOT NULL REFERENCES payments_entries(id) ON DELETE RESTRICT,
  target_month TEXT NOT NULL CHECK(length(target_month) = 7 AND target_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(target_month,6,2) BETWEEN '01' AND '12'),
  amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount >= 0),
  completed_at TEXT,
  PRIMARY KEY(entry_id, target_month)
);
CREATE INDEX payments_marks_completed ON payments_monthly_marks(entry_id, target_month, amount) WHERE completed_at IS NOT NULL;
CREATE TABLE payments_operation_audit (
  request_id TEXT PRIMARY KEY REFERENCES payments_requests(request_id),
  entry_id TEXT NOT NULL REFERENCES payments_entries(id) ON DELETE RESTRICT,
  target_month TEXT,
  action TEXT NOT NULL CHECK(action IN ('entry_create','entry_edit','allocation_change','entry_delete','month_complete','month_undo')),
  occurred_at TEXT NOT NULL,
  identity_id TEXT NOT NULL CHECK(identity_id = 'primary-admin'),
  account_id TEXT NOT NULL CHECK(account_id = 'owner'),
  entry_version INTEGER NOT NULL,
  amount INTEGER,
  previous_amount INTEGER,
  start_month TEXT,
  previous_start_month TEXT,
  months INTEGER,
  previous_months INTEGER
);
CREATE INDEX payments_audit_entry ON payments_operation_audit(entry_id, occurred_at DESC, request_id);
CREATE TRIGGER payments_audit_no_update BEFORE UPDATE ON payments_operation_audit
BEGIN SELECT RAISE(ABORT, 'payments_audit_immutable'); END;
CREATE TRIGGER payments_audit_no_delete BEFORE DELETE ON payments_operation_audit
BEGIN SELECT RAISE(ABORT, 'payments_audit_immutable'); END;
-- A completed allocation cannot be silently rewritten or removed.
CREATE TRIGGER payments_allocation_guard BEFORE UPDATE ON payments_entries
WHEN (NEW.amount != OLD.amount OR NEW.start_month != OLD.start_month OR NEW.months != OLD.months OR NEW.deleted_at IS NOT OLD.deleted_at)
 AND EXISTS(SELECT 1 FROM payments_monthly_marks WHERE entry_id = OLD.id AND completed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'payments_completed_locked'); END;
CREATE TRIGGER payments_mark_insert_guard BEFORE INSERT ON payments_monthly_marks
WHEN NOT EXISTS (
  SELECT 1 FROM payments_entries e WHERE e.id = NEW.entry_id AND e.account_id = 'owner' AND e.deleted_at IS NULL
  AND NEW.target_month >= e.start_month
  AND (CAST(substr(NEW.target_month,1,4) AS INTEGER)*12 + CAST(substr(NEW.target_month,6,2) AS INTEGER))
      < (CAST(substr(e.start_month,1,4) AS INTEGER)*12 + CAST(substr(e.start_month,6,2) AS INTEGER) + e.months)
  AND NEW.amount = e.amount / e.months + CASE WHEN
    (CAST(substr(NEW.target_month,1,4) AS INTEGER)*12 + CAST(substr(NEW.target_month,6,2) AS INTEGER))
      - (CAST(substr(e.start_month,1,4) AS INTEGER)*12 + CAST(substr(e.start_month,6,2) AS INTEGER)) < e.amount % e.months THEN 1 ELSE 0 END
) OR (NEW.completed_at IS NOT NULL AND NEW.target_month > strftime('%Y-%m','now','+9 hours'))
BEGIN SELECT RAISE(ABORT, 'payments_invalid_month'); END;
CREATE TRIGGER payments_mark_update_guard BEFORE UPDATE ON payments_monthly_marks
WHEN NEW.entry_id != OLD.entry_id OR NEW.target_month != OLD.target_month
 OR NOT EXISTS(SELECT 1 FROM payments_entries WHERE id = NEW.entry_id AND deleted_at IS NULL)
 OR NEW.amount != OLD.amount
 OR (NEW.completed_at IS NOT NULL AND NEW.target_month > strftime('%Y-%m','now','+9 hours'))
BEGIN SELECT RAISE(ABORT, 'payments_invalid_month'); END;
-- Cancelled marks are disposable state; immutable operation audit remains.
CREATE TRIGGER payments_reset_cancelled AFTER UPDATE OF amount, start_month, months ON payments_entries
WHEN NEW.amount != OLD.amount OR NEW.start_month != OLD.start_month OR NEW.months != OLD.months
BEGIN DELETE FROM payments_monthly_marks WHERE entry_id = NEW.id AND completed_at IS NULL; END;
