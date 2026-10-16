-- User-visible deletion retains immutable history and lifetime replay protection.
ALTER TABLE inventory_items ADD COLUMN deleted_at TEXT;

CREATE TRIGGER inventory_item_deleted_guard BEFORE UPDATE ON inventory_items
WHEN OLD.deleted_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'inventory_item_deleted');
END;
CREATE TRIGGER inventory_item_delete_version BEFORE UPDATE OF deleted_at ON inventory_items
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL BEGIN
  SELECT RAISE(ABORT, 'inventory_version_conflict') WHERE NEW.version != OLD.version + 1;
END;
CREATE TRIGGER inventory_deleted_movement_insert BEFORE INSERT ON inventory_movements
WHEN EXISTS (SELECT 1 FROM inventory_items WHERE id = NEW.item_id AND account_id = NEW.account_id AND deleted_at IS NOT NULL) BEGIN
  SELECT RAISE(ABORT, 'inventory_item_deleted');
END;
CREATE TRIGGER inventory_deleted_movement_update BEFORE UPDATE ON inventory_movements
WHEN EXISTS (SELECT 1 FROM inventory_items WHERE id = OLD.item_id AND account_id = OLD.account_id AND deleted_at IS NOT NULL) BEGIN
  SELECT RAISE(ABORT, 'inventory_item_deleted');
END;
