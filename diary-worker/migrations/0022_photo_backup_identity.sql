-- Nullable until the independent photo job has verified source and backup.
-- Existing source keys and photo bytes are unchanged. Snapshot payloads with
-- NULL cannot claim photo identity merely from a later receipt.
ALTER TABLE diary_photos ADD COLUMN backup_identity TEXT DEFAULT NULL
  CHECK (backup_identity IS NULL OR json_valid(backup_identity));
