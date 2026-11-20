-- Transient, credential-bound delivery state. A completed delivery is stored
-- in the existing admin_private_prf envelope and the transfer row is removed.
CREATE TABLE security_tcloud_admin_key_transfers (
  credential_id TEXT PRIMARY KEY REFERENCES security_credentials(credential_id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL CHECK (identity_id = 'primary-admin') REFERENCES security_identities(id) ON DELETE CASCADE,
  service_link_id TEXT NOT NULL REFERENCES security_service_links(id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  receiver_ciphertext TEXT NOT NULL,
  receiver_iv TEXT NOT NULL,
  source_credential_id TEXT REFERENCES security_credentials(credential_id) ON DELETE SET NULL,
  admin_key_fingerprint TEXT,
  transfer_ciphertext TEXT,
  transfer_iv TEXT,
  transfer_wrapped_key TEXT
);
