CREATE TABLE security_billing_vaults (
  credential_id TEXT PRIMARY KEY REFERENCES security_credentials(credential_id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES security_identities(id),
  recipient_public_key TEXT NOT NULL,
  recipient_iv TEXT NOT NULL,
  recipient_ciphertext TEXT NOT NULL,
  writer_public_key TEXT,
  writer_iv TEXT,
  writer_ciphertext TEXT,
  CHECK ((writer_public_key IS NULL) = (writer_iv IS NULL)
    AND (writer_iv IS NULL) = (writer_ciphertext IS NULL))
);
