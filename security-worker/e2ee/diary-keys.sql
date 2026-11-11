-- Candidate only. Apply manually to an isolated Security DB for testing.
CREATE TABLE security_diary_key_config (
 id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,
 anchor_json TEXT NOT NULL,directory_json TEXT NOT NULL,recovery_json TEXT NOT NULL
);
CREATE TABLE security_diary_key_vaults (
 recipient_id TEXT PRIMARY KEY,credential_id TEXT NOT NULL,identity_id TEXT NOT NULL,
 service_link_id TEXT NOT NULL,account_id TEXT NOT NULL,vault_json TEXT NOT NULL,
 UNIQUE(credential_id,service_link_id)
);
CREATE TABLE security_diary_key_grants (
 recipient_id TEXT NOT NULL,service_link_id TEXT NOT NULL,generation INTEGER NOT NULL,
 grants_json TEXT NOT NULL,record_grants_json TEXT NOT NULL,PRIMARY KEY(recipient_id,generation)
);
