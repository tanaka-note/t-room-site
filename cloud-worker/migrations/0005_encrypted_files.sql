ALTER TABLE cloud_files ADD COLUMN crypto_version INTEGER;
ALTER TABLE cloud_files ADD COLUMN encrypted_metadata TEXT;
ALTER TABLE cloud_files ADD COLUMN metadata_iv TEXT;
ALTER TABLE cloud_files ADD COLUMN wrapped_file_key TEXT;
ALTER TABLE cloud_files ADD COLUMN file_key_iv TEXT;
ALTER TABLE cloud_files ADD COLUMN encrypted_size_bytes INTEGER;
ALTER TABLE cloud_files ADD COLUMN chunk_size_bytes INTEGER;
ALTER TABLE cloud_files ADD COLUMN chunk_count INTEGER;

CREATE INDEX IF NOT EXISTS cloud_files_crypto_idx
  ON cloud_files(crypto_version, folder_id, deleted_at, status);
