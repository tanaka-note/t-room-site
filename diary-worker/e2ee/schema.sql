-- Candidate schema for an ISOLATED database; deliberately outside migrations/.
-- No dates, titles, tags, text, names, MIME types or original filenames.
CREATE TABLE diary_e2ee_control (
 id INTEGER PRIMARY KEY CHECK(id=1),
 phase TEXT NOT NULL CHECK(phase IN ('legacy','migrating','encrypted','paused','restoring')),
 generation INTEGER NOT NULL CHECK(generation>=0),
 ever_encrypted INTEGER NOT NULL CHECK(ever_encrypted IN (0,1)),
 evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence))
);
INSERT INTO diary_e2ee_control VALUES(1,'legacy',0,0,NULL);
CREATE TABLE diary_e2ee_records (
 id TEXT PRIMARY KEY, household TEXT NOT NULL, scope TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('published','draft','trash','preferences')),
 author TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), epoch INTEGER NOT NULL CHECK(epoch>0),
 source_id TEXT, source_revision INTEGER,
 retained_for TEXT NOT NULL CHECK(json_valid(retained_for)),
 envelope TEXT NOT NULL CHECK(json_valid(envelope)), summary TEXT NOT NULL CHECK(json_valid(summary)),
 photo_ids TEXT NOT NULL CHECK(json_valid(photo_ids)), request_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
 key_box TEXT NOT NULL CHECK(json_valid(key_box)), attestation TEXT NOT NULL CHECK(json_valid(attestation)),
 UNIQUE(household,author,request_id)
);
CREATE INDEX diary_e2ee_record_household ON diary_e2ee_records(household,id);
CREATE UNIQUE INDEX diary_e2ee_edit_draft ON diary_e2ee_records(household,source_id)
 WHERE state='draft' AND source_id IS NOT NULL;
CREATE TABLE diary_e2ee_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, household TEXT NOT NULL,
 revision INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1))
);
CREATE TRIGGER diary_e2ee_created AFTER INSERT ON diary_e2ee_records BEGIN
 INSERT INTO diary_e2ee_changes(id,household,revision,deleted) VALUES(NEW.id,NEW.household,NEW.revision,0);
END;
CREATE TRIGGER diary_e2ee_updated AFTER UPDATE ON diary_e2ee_records BEGIN
 INSERT INTO diary_e2ee_changes(id,household,revision,deleted) VALUES(NEW.id,NEW.household,NEW.revision,0);
END;
CREATE TRIGGER diary_e2ee_deleted AFTER DELETE ON diary_e2ee_records BEGIN
 INSERT INTO diary_e2ee_changes(id,household,revision,deleted) VALUES(OLD.id,OLD.household,OLD.revision+1,1);
END;
CREATE INDEX diary_e2ee_change_household ON diary_e2ee_changes(household,seq);
CREATE TABLE diary_e2ee_requests (
 household TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)),
 PRIMARY KEY(household,account_id,request_id)
);

-- Opaque IDs only. A later media adapter drains this queue after cutover.
-- Enqueue is transactional; IDs cannot be reattached after retirement.
CREATE TABLE diary_e2ee_media_gc (
 photo_id TEXT PRIMARY KEY, household TEXT NOT NULL, mutation_id TEXT NOT NULL
);
CREATE TABLE diary_e2ee_media (
 id TEXT PRIMARY KEY,household TEXT NOT NULL,account_id TEXT NOT NULL,session_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('uploading','ready','attached','retiring')),
 original_key TEXT NOT NULL,display_key TEXT NOT NULL,thumbnail_key TEXT NOT NULL,
 metadata TEXT NOT NULL CHECK(json_valid(metadata)),epoch INTEGER NOT NULL,
 request_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,retired_at INTEGER
);
CREATE TABLE diary_e2ee_uploads (
 id TEXT PRIMARY KEY,household TEXT NOT NULL,account_id TEXT NOT NULL,target_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','committed','retiring')),
 expires_at INTEGER NOT NULL,committed_entry TEXT,committed_ids TEXT
);

-- Storage, rather than a browser flag, is the final write fence.
CREATE TRIGGER diary_e2ee_write_insert BEFORE INSERT ON diary_e2ee_records
 WHEN COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1),'paused') NOT IN ('encrypted','migrating','restoring')
 BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_write_update BEFORE UPDATE ON diary_e2ee_records
 WHEN COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1),'paused')!='encrypted'
 BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_write_delete BEFORE DELETE ON diary_e2ee_records
 WHEN COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1),'paused')!='encrypted'
 BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_no_plaintext_downgrade BEFORE UPDATE ON diary_e2ee_control
 WHEN OLD.ever_encrypted=1 AND (NEW.ever_encrypted!=1 OR NEW.phase IN ('legacy','migrating','restoring'))
 BEGIN SELECT RAISE(ABORT,'PlaintextRollbackForbidden'); END;
CREATE TRIGGER diary_e2ee_control_required BEFORE DELETE ON diary_e2ee_control
 BEGIN SELECT RAISE(ABORT,'RolloutControlRequired'); END;
CREATE TRIGGER diary_e2ee_media_insert_fence BEFORE INSERT ON diary_e2ee_media WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) IN ('encrypted','migrating','restoring'),0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_media_update_fence BEFORE UPDATE ON diary_e2ee_media WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_media_delete_fence BEFORE DELETE ON diary_e2ee_media WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_uploads_insert_fence BEFORE INSERT ON diary_e2ee_uploads WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) IN ('encrypted','migrating','restoring'),0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_uploads_update_fence BEFORE UPDATE ON diary_e2ee_uploads WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_e2ee_uploads_delete_fence BEFORE DELETE ON diary_e2ee_uploads WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
