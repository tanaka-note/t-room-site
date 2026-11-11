-- Candidate schema for an ISOLATED database; deliberately outside migrations/.
-- No dates, titles, tags, text, names, MIME types or original filenames.
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
