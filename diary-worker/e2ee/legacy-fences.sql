-- Apply manually ONLY after the normal schema and before beginning migration.
-- Keeping this outside migrations prevents automatic production application.
-- Old Worker versions are also stopped by these DB guards. They must never be
-- used as an encrypted-data rollback target: they cannot read ciphertext.
CREATE TRIGGER diary_plaintext_entry_insert BEFORE INSERT ON diary_entries WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_entry_update BEFORE UPDATE ON diary_entries WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_entry_delete BEFORE DELETE ON diary_entries WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_tag_insert BEFORE INSERT ON diary_tags WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_tag_update BEFORE UPDATE ON diary_tags WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_tag_delete BEFORE DELETE ON diary_tags WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_photo_insert BEFORE INSERT ON diary_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_photo_update BEFORE UPDATE ON diary_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_photo_delete BEFORE DELETE ON diary_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_favorite_insert BEFORE INSERT ON diary_favorites WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_favorite_update BEFORE UPDATE ON diary_favorites WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_favorite_delete BEFORE DELETE ON diary_favorites WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_upload_insert BEFORE INSERT ON diary_photo_upload_sessions WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_upload_update BEFORE UPDATE ON diary_photo_upload_sessions WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_upload_delete BEFORE DELETE ON diary_photo_upload_sessions WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_staged_insert BEFORE INSERT ON diary_staged_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_staged_update BEFORE UPDATE ON diary_staged_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
CREATE TRIGGER diary_plaintext_staged_delete BEFORE DELETE ON diary_staged_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;
