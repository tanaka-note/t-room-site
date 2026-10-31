-- Additive only. Never backfill legacy trash into a verified operation.
ALTER TABLE cloud_files ADD COLUMN trash_operation_id TEXT;
ALTER TABLE cloud_files ADD COLUMN purge_id TEXT;
ALTER TABLE cloud_folders ADD COLUMN trash_operation_id TEXT;

CREATE TABLE cloud_trash_operations (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('file', 'folder')),
  target_id INTEGER NOT NULL,
  purge_started INTEGER NOT NULL DEFAULT 0 CHECK(purge_started IN (0,1))
);
CREATE TABLE cloud_trash_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  emergency_stop INTEGER NOT NULL DEFAULT 0 CHECK(emergency_stop IN (0,1)),
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_candidate_count INTEGER
);
INSERT INTO cloud_trash_control(id) VALUES(1);
-- Keep completed manifests: keys are permanently reserved against reuse.
CREATE TABLE cloud_trash_purges (
  id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL UNIQUE,
  operation_id TEXT,
  deleted_at TEXT NOT NULL,
  folder_id INTEGER,
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  display_thumbnail_key TEXT,
  stream_uid TEXT,
  size_bytes INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','automatic')),
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'claimed' CHECK(phase IN ('claimed','objects_deleted','completed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX cloud_trash_files_due ON cloud_files(deleted_at,id) WHERE trash_operation_id IS NOT NULL;
CREATE INDEX cloud_trash_folders_due ON cloud_folders(deleted_at,id) WHERE trash_operation_id IS NOT NULL;
CREATE INDEX cloud_trash_purge_keys ON cloud_trash_purges(object_key);
CREATE TABLE cloud_trash_folder_purges (
  id TEXT PRIMARY KEY,
  folder_id INTEGER NOT NULL UNIQUE,
  parent_id INTEGER,
  operation_id TEXT,
  deleted_at TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Once destructive work is committed, no stale API can restore or mutate it.
CREATE TRIGGER cloud_trash_file_frozen BEFORE UPDATE ON cloud_files
WHEN OLD.purge_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'trash_purge_in_progress'); END;
CREATE TRIGGER cloud_trash_file_restore_guard BEFORE UPDATE OF deleted_at ON cloud_files
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM cloud_trash_operations WHERE id=OLD.trash_operation_id AND purge_started=1)
BEGIN SELECT RAISE(ABORT, 'trash_purge_in_progress'); END;
CREATE TRIGGER cloud_trash_folder_restore_guard BEFORE UPDATE OF deleted_at ON cloud_folders
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND (
  EXISTS(SELECT 1 FROM cloud_trash_operations WHERE id=OLD.trash_operation_id AND purge_started=1)
  OR EXISTS(WITH RECURSIVE tree(id) AS (
    SELECT OLD.id UNION SELECT f.id FROM cloud_folders f JOIN tree t ON f.parent_id=t.id
  ) SELECT 1 FROM cloud_files f JOIN tree ON f.folder_id=tree.id WHERE f.purge_id IS NOT NULL)
  OR EXISTS(WITH RECURSIVE tree(id) AS (
    SELECT OLD.id UNION SELECT f.id FROM cloud_folders f JOIN tree t ON f.parent_id=t.id
  ) SELECT 1 FROM cloud_trash_purges p JOIN tree ON p.folder_id=tree.id
    WHERE julianday(OLD.deleted_at) IS NULL OR julianday(p.created_at)>=julianday(OLD.deleted_at))
  OR EXISTS(WITH RECURSIVE tree(id) AS (
    SELECT OLD.id UNION SELECT f.id FROM cloud_folders f JOIN tree t ON f.parent_id=t.id
  ) SELECT 1 FROM cloud_trash_folder_purges p JOIN tree ON p.parent_id=tree.id
    WHERE julianday(OLD.deleted_at) IS NULL OR julianday(p.occurred_at)>=julianday(OLD.deleted_at))
)
BEGIN SELECT RAISE(ABORT, 'trash_purge_in_progress'); END;
CREATE TRIGGER cloud_trash_file_delete_guard BEFORE DELETE ON cloud_files
WHEN OLD.deleted_at IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM cloud_trash_purges WHERE id=OLD.purge_id AND file_id=OLD.id AND phase='objects_deleted'
)
BEGIN SELECT RAISE(ABORT, 'trash_purge_not_confirmed'); END;
CREATE TRIGGER cloud_trash_folder_delete_guard BEFORE DELETE ON cloud_folders
WHEN EXISTS(SELECT 1 FROM cloud_files WHERE folder_id=OLD.id)
  OR EXISTS(SELECT 1 FROM cloud_folders WHERE parent_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'trash_folder_not_empty'); END;

CREATE TRIGGER cloud_trash_folder_claim AFTER INSERT ON cloud_trash_folder_purges
BEGIN UPDATE cloud_trash_operations SET purge_started=1 WHERE id=NEW.operation_id; END;
CREATE TRIGGER cloud_trash_folder_manifest_retain BEFORE DELETE ON cloud_trash_folder_purges
BEGIN SELECT RAISE(ABORT, 'trash_manifest_retain'); END;
CREATE TRIGGER cloud_trash_folder_manifest_immutable BEFORE UPDATE ON cloud_trash_folder_purges
BEGIN SELECT RAISE(ABORT, 'trash_manifest_immutable'); END;

-- No move/upload may race into a trashed parent after the API's access check.
CREATE TRIGGER cloud_trash_file_parent_insert BEFORE INSERT ON cloud_files
WHEN EXISTS(SELECT 1 FROM cloud_folders WHERE id=NEW.folder_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'trash_parent_unavailable'); END;
CREATE TRIGGER cloud_trash_file_parent_update BEFORE UPDATE OF folder_id ON cloud_files
WHEN OLD.folder_id IS NOT NEW.folder_id AND (OLD.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM cloud_folders WHERE id=NEW.folder_id AND deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'trash_parent_unavailable'); END;
CREATE TRIGGER cloud_trash_folder_parent_insert BEFORE INSERT ON cloud_folders
WHEN EXISTS(SELECT 1 FROM cloud_folders WHERE id=NEW.parent_id AND deleted_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'trash_parent_unavailable'); END;
CREATE TRIGGER cloud_trash_folder_parent_update BEFORE UPDATE OF parent_id ON cloud_folders
WHEN OLD.parent_id IS NOT NEW.parent_id AND (OLD.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM cloud_folders WHERE id=NEW.parent_id AND deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'trash_parent_unavailable'); END;

CREATE TRIGGER cloud_trash_reserved_insert BEFORE INSERT ON cloud_files
WHEN EXISTS(SELECT 1 FROM cloud_trash_purges p WHERE
    NEW.object_key IN (p.object_key,p.thumbnail_key,p.display_thumbnail_key)
    OR NEW.thumbnail_key IN (p.object_key,p.thumbnail_key,p.display_thumbnail_key)
    OR NEW.display_thumbnail_key IN (p.object_key,p.thumbnail_key,p.display_thumbnail_key)
    OR (NEW.stream_uid IS NOT NULL AND NEW.stream_uid=p.stream_uid))
BEGIN SELECT RAISE(ABORT, 'trash_key_reserved'); END;
CREATE TRIGGER cloud_trash_reserved_update BEFORE UPDATE OF object_key,thumbnail_key,display_thumbnail_key,stream_uid ON cloud_files
WHEN EXISTS(SELECT 1 FROM cloud_trash_purges p WHERE
    NEW.object_key IN (p.object_key,p.thumbnail_key,p.display_thumbnail_key)
    OR NEW.thumbnail_key IN (p.object_key,p.thumbnail_key,p.display_thumbnail_key)
    OR NEW.display_thumbnail_key IN (p.object_key,p.thumbnail_key,p.display_thumbnail_key)
    OR (NEW.stream_uid IS NOT NULL AND NEW.stream_uid=p.stream_uid))
BEGIN SELECT RAISE(ABORT, 'trash_key_reserved'); END;

CREATE TRIGGER cloud_trash_claim_guard BEFORE INSERT ON cloud_trash_purges
WHEN NOT EXISTS(SELECT 1 FROM cloud_files f WHERE f.id=NEW.file_id
  AND f.deleted_at=NEW.deleted_at AND f.deleted_at IS NOT NULL AND f.status='ready'
  AND f.trash_operation_id IS NEW.operation_id AND f.purge_id IS NULL
  AND f.object_key=NEW.object_key AND f.thumbnail_key IS NEW.thumbnail_key
  AND f.display_thumbnail_key IS NEW.display_thumbnail_key AND f.stream_uid IS NEW.stream_uid)
  OR EXISTS(SELECT 1 FROM cloud_files f WHERE f.id<>NEW.file_id AND (
    f.object_key IN (NEW.object_key,NEW.thumbnail_key,NEW.display_thumbnail_key)
    OR f.thumbnail_key IN (NEW.object_key,NEW.thumbnail_key,NEW.display_thumbnail_key)
    OR f.display_thumbnail_key IN (NEW.object_key,NEW.thumbnail_key,NEW.display_thumbnail_key)
    OR (NEW.stream_uid IS NOT NULL AND f.stream_uid=NEW.stream_uid)))
BEGIN SELECT RAISE(ABORT, 'trash_claim_mismatch_or_shared_key'); END;
CREATE TRIGGER cloud_trash_claim_commit AFTER INSERT ON cloud_trash_purges
BEGIN
  UPDATE cloud_files SET purge_id=NEW.id WHERE id=NEW.file_id AND purge_id IS NULL;
  UPDATE cloud_trash_operations SET purge_started=1 WHERE id=NEW.operation_id;
END;
-- Repeat recursive validation inside the same write transaction as the claim.
-- JS preflight alone is insufficient: restore may win between two awaits.
CREATE TRIGGER cloud_trash_claim_tree_guard BEFORE INSERT ON cloud_trash_purges
WHEN EXISTS(
  WITH RECURSIVE ancestors(id,parent_id,deleted_at) AS (
    SELECT id,parent_id,deleted_at FROM cloud_folders WHERE id=NEW.folder_id
    UNION SELECT p.id,p.parent_id,p.deleted_at FROM cloud_folders p JOIN ancestors a ON p.id=a.parent_id
  ), tree(id) AS (
    SELECT id FROM ancestors WHERE deleted_at IS NOT NULL
    UNION SELECT f.id FROM cloud_folders f JOIN tree t ON f.parent_id=t.id
  )
  SELECT 1 FROM cloud_folders f JOIN tree t ON f.id=t.id WHERE f.deleted_at IS NULL
    OR (NEW.source='automatic' AND (f.deleted_at IS NOT NEW.deleted_at OR f.trash_operation_id IS NOT NEW.operation_id))
  UNION ALL
  SELECT 1 FROM cloud_files f JOIN tree t ON f.folder_id=t.id WHERE f.deleted_at IS NULL OR f.status<>'ready'
    OR (NEW.source='automatic' AND (f.deleted_at IS NOT NEW.deleted_at OR f.trash_operation_id IS NOT NEW.operation_id))
)
BEGIN SELECT RAISE(ABORT, 'trash_inconsistent_folder_tree'); END;
CREATE TRIGGER cloud_trash_manifest_immutable BEFORE UPDATE OF id,file_id,operation_id,deleted_at,folder_id,object_key,thumbnail_key,display_thumbnail_key,stream_uid,size_bytes,source,run_id,created_at ON cloud_trash_purges
BEGIN SELECT RAISE(ABORT, 'trash_manifest_immutable'); END;
CREATE TRIGGER cloud_trash_manifest_retain BEFORE DELETE ON cloud_trash_purges
BEGIN SELECT RAISE(ABORT, 'trash_manifest_retain'); END;
