-- Observes existing writers; no changes to Web authentication or file encryption.
CREATE TABLE cloud_windows_catalog_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  epoch TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  history_floor INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cloud_windows_catalog_control(id) VALUES(1);
CREATE TABLE cloud_windows_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('file','folder')),
  entity_id INTEGER NOT NULL,
  parent_id INTEGER,
  state TEXT NOT NULL CHECK(state IN ('present','pending','trashed','purged','unknown')),
  ancestors TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX cloud_windows_entity_version ON cloud_windows_changes(kind,entity_id,seq);
CREATE TABLE cloud_windows_heads (
  kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  seq INTEGER NOT NULL REFERENCES cloud_windows_changes(seq),
  PRIMARY KEY(kind,entity_id)
);

CREATE VIEW cloud_windows_file_projection AS
SELECT f.id AS entity_id, f.folder_id AS parent_id,
  (WITH RECURSIVE a(id,parent_id,protected,deleted,depth) AS (
    SELECT id,parent_id,password_hash IS NOT NULL,deleted_at IS NOT NULL,0 FROM cloud_folders WHERE id=f.folder_id
    UNION ALL SELECT p.id,p.parent_id,p.password_hash IS NOT NULL,p.deleted_at IS NOT NULL,a.depth+1 FROM cloud_folders p JOIN a ON p.id=a.parent_id WHERE a.depth<99
  ) SELECT json_group_array(json_object('id',id,'parentId',parent_id,'isProtected',protected,'isDeleted',deleted)) FROM a) AS ancestors,
  CASE WHEN f.status!='ready' THEN 'pending' WHEN f.deleted_at IS NULL THEN 'present'
    WHEN EXISTS(SELECT 1 FROM cloud_trash_operations op WHERE op.id=f.trash_operation_id AND op.deleted_at=f.deleted_at AND
      ((op.target_type='file' AND op.target_id=f.id) OR (op.target_type='folder' AND op.target_id IN (
        WITH RECURSIVE a(id,parent_id,depth) AS (
          SELECT id,parent_id,0 FROM cloud_folders WHERE id=f.folder_id
          UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM cloud_folders p JOIN a ON p.id=a.parent_id WHERE a.depth<99
        ) SELECT id FROM a)))) THEN 'trashed' ELSE 'unknown' END AS state,
  json_object('id',f.id,'folderId',f.folder_id,'name',f.original_name,'mimeType',f.mime_type,'mediaKind',f.media_kind,
    'sizeBytes',f.size_bytes,'cryptoVersion',f.crypto_version,'encryptedMetadata',f.encrypted_metadata,'metadataIv',f.metadata_iv,
    'wrappedFileKey',f.wrapped_file_key,'fileKeyIv',f.file_key_iv,'chunkSizeBytes',f.chunk_size_bytes,'chunkCount',f.chunk_count,
    'encryptedSizeBytes',f.encrypted_size_bytes,'objectKey',f.object_key,'createdAt',f.created_at,'updatedAt',f.updated_at,
    'deletedAt',f.deleted_at,'trashOperationId',f.trash_operation_id) AS payload
FROM cloud_files f;

CREATE VIEW cloud_windows_folder_projection AS
SELECT f.id AS entity_id, f.parent_id,
  (WITH RECURSIVE a(id,parent_id,protected,deleted,depth) AS (
    SELECT f.id,f.parent_id,f.password_hash IS NOT NULL,f.deleted_at IS NOT NULL,0
    UNION ALL SELECT p.id,p.parent_id,p.password_hash IS NOT NULL,p.deleted_at IS NOT NULL,a.depth+1 FROM cloud_folders p JOIN a ON p.id=a.parent_id WHERE a.depth<99
  ) SELECT json_group_array(json_object('id',id,'parentId',parent_id,'isProtected',protected,'isDeleted',deleted)) FROM a) AS ancestors,
  CASE WHEN f.deleted_at IS NULL THEN 'present'
    WHEN EXISTS(SELECT 1 FROM cloud_trash_operations op WHERE op.id=f.trash_operation_id AND op.deleted_at=f.deleted_at
      AND op.target_type='folder' AND op.target_id IN (
        WITH RECURSIVE a(id,parent_id,depth) AS (
          SELECT f.id,f.parent_id,0
          UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM cloud_folders p JOIN a ON p.id=a.parent_id WHERE a.depth<99
        ) SELECT id FROM a)) THEN 'trashed' ELSE 'unknown' END AS state,
  json_object('id',f.id,'parentId',f.parent_id,'name',f.name,'cryptoVersion',f.crypto_version,'encryptedName',f.encrypted_name,
    'nameIv',f.name_iv,'adminWrappedKey',f.admin_wrapped_key,'parentWrappedKey',f.parent_wrapped_key,'parentWrapIv',f.parent_wrap_iv,
    'isProtected',f.password_hash IS NOT NULL,'createdAt',f.created_at,'updatedAt',f.updated_at,
    'deletedAt',f.deleted_at,'trashOperationId',f.trash_operation_id) AS payload
FROM cloud_folders f;

-- Seed the current catalog, including verified trash. A missing list item is
-- never deletion evidence; tombstones remain in heads after permanent deletion.
INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
SELECT 'folder',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_folder_projection;
INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
SELECT 'file',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_file_projection;
INSERT INTO cloud_windows_heads(kind,entity_id,seq) SELECT kind,entity_id,seq FROM cloud_windows_changes;

CREATE TRIGGER cloud_windows_file_insert AFTER INSERT ON cloud_files BEGIN
  INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
    SELECT 'file',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_file_projection WHERE entity_id=NEW.id;
  INSERT INTO cloud_windows_heads VALUES('file',NEW.id,last_insert_rowid()) ON CONFLICT(kind,entity_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER cloud_windows_file_update AFTER UPDATE ON cloud_files
WHEN OLD.folder_id IS NOT NEW.folder_id OR OLD.object_key IS NOT NEW.object_key OR OLD.original_name IS NOT NEW.original_name
  OR OLD.size_bytes IS NOT NEW.size_bytes OR OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.crypto_version IS NOT NEW.crypto_version OR OLD.encrypted_metadata IS NOT NEW.encrypted_metadata OR OLD.metadata_iv IS NOT NEW.metadata_iv
  OR OLD.wrapped_file_key IS NOT NEW.wrapped_file_key OR OLD.file_key_iv IS NOT NEW.file_key_iv
  OR OLD.chunk_size_bytes IS NOT NEW.chunk_size_bytes OR OLD.chunk_count IS NOT NEW.chunk_count OR OLD.encrypted_size_bytes IS NOT NEW.encrypted_size_bytes
  OR OLD.trash_operation_id IS NOT NEW.trash_operation_id OR OLD.purge_id IS NOT NEW.purge_id
BEGIN
  INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
    SELECT 'file',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_file_projection WHERE entity_id=NEW.id;
  INSERT INTO cloud_windows_heads VALUES('file',NEW.id,last_insert_rowid()) ON CONFLICT(kind,entity_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER cloud_windows_file_delete BEFORE DELETE ON cloud_files BEGIN
  INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
    SELECT 'file',entity_id,parent_id,CASE WHEN state='trashed' AND OLD.purge_id IS NOT NULL THEN 'purged' ELSE 'unknown' END,
      ancestors,json_object('deletedAt',OLD.deleted_at,'trashOperationId',OLD.trash_operation_id)
    FROM cloud_windows_file_projection WHERE entity_id=OLD.id;
  INSERT INTO cloud_windows_heads VALUES('file',OLD.id,last_insert_rowid()) ON CONFLICT(kind,entity_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER cloud_windows_folder_insert AFTER INSERT ON cloud_folders BEGIN
  INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
    SELECT 'folder',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_folder_projection WHERE entity_id=NEW.id;
  INSERT INTO cloud_windows_heads VALUES('folder',NEW.id,last_insert_rowid()) ON CONFLICT(kind,entity_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER cloud_windows_folder_update AFTER UPDATE ON cloud_folders
WHEN OLD.parent_id IS NOT NEW.parent_id OR OLD.name IS NOT NEW.name OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.crypto_version IS NOT NEW.crypto_version OR OLD.encrypted_name IS NOT NEW.encrypted_name OR OLD.name_iv IS NOT NEW.name_iv
  OR OLD.admin_wrapped_key IS NOT NEW.admin_wrapped_key OR OLD.parent_wrapped_key IS NOT NEW.parent_wrapped_key OR OLD.parent_wrap_iv IS NOT NEW.parent_wrap_iv
  OR OLD.trash_operation_id IS NOT NEW.trash_operation_id OR OLD.password_hash IS NOT NEW.password_hash
BEGIN
  INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
    SELECT 'folder',entity_id,parent_id,state,ancestors,payload FROM cloud_windows_folder_projection WHERE entity_id=NEW.id;
  INSERT INTO cloud_windows_heads VALUES('folder',NEW.id,last_insert_rowid()) ON CONFLICT(kind,entity_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER cloud_windows_folder_delete BEFORE DELETE ON cloud_folders BEGIN
  INSERT INTO cloud_windows_changes(kind,entity_id,parent_id,state,ancestors,payload)
    SELECT 'folder',entity_id,parent_id,CASE WHEN state='trashed' THEN 'purged' ELSE 'unknown' END,
      ancestors,json_object('deletedAt',OLD.deleted_at,'trashOperationId',OLD.trash_operation_id)
    FROM cloud_windows_folder_projection WHERE entity_id=OLD.id;
  INSERT INTO cloud_windows_heads VALUES('folder',OLD.id,last_insert_rowid()) ON CONFLICT(kind,entity_id) DO UPDATE SET seq=excluded.seq;
END;
