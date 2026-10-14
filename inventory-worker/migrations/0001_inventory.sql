-- Schema only. Personal account data is supplied separately at deployment.
CREATE TABLE inventory_accounts (
  id TEXT PRIMARY KEY CHECK (id = 'owner'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1)
);
CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES inventory_accounts(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  unit TEXT NOT NULL CHECK (length(unit) BETWEEN 1 AND 12),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stock) = 'integer' AND stock BETWEEN 0 AND 1000000000),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (id, account_id)
);
CREATE TABLE inventory_movements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'restock', 'use', 'adjust')),
  quantity_delta INTEGER NOT NULL CHECK (typeof(quantity_delta) = 'integer' AND abs(quantity_delta) <= 1000000000),
  expected_version INTEGER,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  FOREIGN KEY (item_id, account_id) REFERENCES inventory_items(id, account_id),
  CHECK ((kind = 'opening' AND quantity_delta >= 0) OR (kind = 'restock' AND quantity_delta > 0)
    OR (kind = 'use' AND quantity_delta < 0) OR kind = 'adjust'),
  CHECK ((kind = 'adjust' AND expected_version IS NOT NULL) OR (kind != 'adjust' AND expected_version IS NULL))
);
CREATE UNIQUE INDEX inventory_one_opening ON inventory_movements(item_id) WHERE kind = 'opening';
CREATE INDEX inventory_movement_period ON inventory_movements(account_id, item_id, occurred_at, id);
CREATE TABLE inventory_requests (
  account_id TEXT NOT NULL REFERENCES inventory_accounts(id),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, request_id)
);
CREATE TRIGGER inventory_movement_guard BEFORE INSERT ON inventory_movements BEGIN
  SELECT RAISE(ABORT, 'inventory_item_unavailable') WHERE NOT EXISTS (SELECT 1 FROM inventory_items
    WHERE id = NEW.item_id AND account_id = NEW.account_id AND archived_at IS NULL)
    ;
  SELECT RAISE(ABORT, 'inventory_version_conflict') WHERE NEW.kind = 'adjust' AND NEW.expected_version !=
    (SELECT version FROM inventory_items WHERE id = NEW.item_id);
END;
CREATE TRIGGER inventory_movement_apply AFTER INSERT ON inventory_movements BEGIN
  UPDATE inventory_items SET stock = stock + NEW.quantity_delta, version = version + 1 WHERE id = NEW.item_id;
END;
CREATE TRIGGER inventory_movement_immutable BEFORE UPDATE ON inventory_movements BEGIN
  SELECT RAISE(ABORT, 'inventory_movement_immutable') WHERE OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
    OR NEW.id != OLD.id OR NEW.account_id != OLD.account_id OR NEW.item_id != OLD.item_id
    OR NEW.kind != OLD.kind OR NEW.quantity_delta != OLD.quantity_delta
    OR NEW.expected_version IS NOT OLD.expected_version
    OR NEW.occurred_at != OLD.occurred_at OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'inventory_opening_required') WHERE OLD.kind = 'opening';
END;
CREATE TRIGGER inventory_movement_void AFTER UPDATE OF voided_at ON inventory_movements BEGIN
  UPDATE inventory_items SET stock = stock - OLD.quantity_delta, version = version + 1 WHERE id = OLD.item_id;
  UPDATE inventory_items SET archived_at = NULL WHERE id = OLD.item_id AND stock > 0 AND archived_at IS NOT NULL;
END;
CREATE TRIGGER inventory_movement_keep BEFORE DELETE ON inventory_movements BEGIN
  SELECT RAISE(ABORT, 'inventory_history_required');
END;
CREATE TRIGGER inventory_archive_guard BEFORE UPDATE OF archived_at ON inventory_items
WHEN NEW.archived_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'inventory_archive_conflict') WHERE OLD.stock != 0 OR OLD.archived_at IS NOT NULL;
END;
