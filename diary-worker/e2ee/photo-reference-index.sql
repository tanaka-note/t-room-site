-- Rebuildable index of signed records' existing opaque photo IDs.
-- Apply to an encrypted Diary database after the compatible Backup Worker.
CREATE TABLE diary_photo_refs (
  photo_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY(photo_id, record_id)
) WITHOUT ROWID;

CREATE INDEX diary_photo_refs_by_record ON diary_photo_refs(record_id);

CREATE TRIGGER diary_photo_refs_record_insert AFTER INSERT ON diary_e2ee_records
BEGIN
  INSERT OR IGNORE INTO diary_photo_refs(photo_id, record_id)
    SELECT value, NEW.id FROM json_each(NEW.photo_ids) WHERE type='text';
END;

CREATE TRIGGER diary_photo_refs_record_update AFTER UPDATE OF id, photo_ids ON diary_e2ee_records
  WHEN OLD.id<>NEW.id OR OLD.photo_ids<>NEW.photo_ids
BEGIN
  DELETE FROM diary_photo_refs WHERE record_id=OLD.id;
  INSERT OR IGNORE INTO diary_photo_refs(photo_id, record_id)
    SELECT value, NEW.id FROM json_each(NEW.photo_ids) WHERE type='text';
END;

CREATE TRIGGER diary_photo_refs_record_delete AFTER DELETE ON diary_e2ee_records
BEGIN
  DELETE FROM diary_photo_refs WHERE record_id=OLD.id;
END;

INSERT OR IGNORE INTO diary_photo_refs(photo_id, record_id)
  SELECT p.value, r.id FROM diary_e2ee_records r, json_each(r.photo_ids) p WHERE p.type='text';
