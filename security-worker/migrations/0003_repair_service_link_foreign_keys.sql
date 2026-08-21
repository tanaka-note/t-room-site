PRAGMA foreign_keys = OFF;

ALTER TABLE security_handoffs RENAME TO security_handoffs_legacy;

CREATE TABLE security_handoffs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links(id),
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id)
);

INSERT INTO security_handoffs
  (id, token_hash, identity_id, service_link_id, credential_id, expires_at, consumed_at, created_at)
SELECT id, token_hash, identity_id, service_link_id, credential_id, expires_at, consumed_at, created_at
FROM security_handoffs_legacy;

DROP TABLE security_handoffs_legacy;

CREATE INDEX idx_security_handoffs_expiry
ON security_handoffs(expires_at, consumed_at);

ALTER TABLE security_tcloud_key_envelopes RENAME TO security_tcloud_key_envelopes_legacy;

CREATE TABLE security_tcloud_key_envelopes (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  service_link_id TEXT NOT NULL,
  envelope_type TEXT NOT NULL CHECK (envelope_type IN ('admin_private_prf', 'client_private_prf', 'folder_key_rsa')),
  public_key_jwk TEXT,
  encrypted_payload TEXT,
  payload_iv TEXT,
  wrapped_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (credential_id, service_link_id, envelope_type),
  FOREIGN KEY (identity_id) REFERENCES security_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES security_credentials(credential_id) ON DELETE CASCADE,
  FOREIGN KEY (service_link_id) REFERENCES security_service_links(id) ON DELETE CASCADE
);

INSERT INTO security_tcloud_key_envelopes
  (id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk,
   encrypted_payload, payload_iv, wrapped_key, created_at, updated_at)
SELECT id, identity_id, credential_id, service_link_id, envelope_type, public_key_jwk,
       encrypted_payload, payload_iv, wrapped_key, created_at, updated_at
FROM security_tcloud_key_envelopes_legacy;

DROP TABLE security_tcloud_key_envelopes_legacy;

DELETE FROM security_tcloud_key_envelopes
WHERE envelope_type = 'client_private_prf'
  AND EXISTS (
    SELECT 1 FROM security_tcloud_client_vaults vault
    WHERE vault.credential_id = security_tcloud_key_envelopes.credential_id
  );

PRAGMA foreign_keys = ON;
