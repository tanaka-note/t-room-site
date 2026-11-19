-- Windows device grants observe authority changes without extending Web sessions.
-- Keep tombstones so delete/recreate or disable/re-enable cannot revive a grant.
CREATE TABLE security_windows_authority_versions (
  kind TEXT NOT NULL CHECK(kind IN ('identity','credential','link')),
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  PRIMARY KEY(kind, entity_id)
);
INSERT INTO security_windows_authority_versions SELECT 'identity', id, 1 FROM security_identities;
INSERT INTO security_windows_authority_versions SELECT 'credential', credential_id, 1 FROM security_credentials;
INSERT INTO security_windows_authority_versions SELECT 'link', id, 1 FROM security_service_links;

CREATE TRIGGER windows_identity_insert AFTER INSERT ON security_identities BEGIN
  INSERT INTO security_windows_authority_versions VALUES('identity',NEW.id,1)
  ON CONFLICT(kind,entity_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER windows_identity_change AFTER UPDATE ON security_identities
WHEN OLD.status IS NOT NEW.status OR OLD.is_security_admin IS NOT NEW.is_security_admin BEGIN
  UPDATE security_windows_authority_versions SET revision=revision+1 WHERE kind='identity' AND entity_id=OLD.id;
END;
CREATE TRIGGER windows_identity_delete AFTER DELETE ON security_identities BEGIN
  UPDATE security_windows_authority_versions SET revision=revision+1 WHERE kind='identity' AND entity_id=OLD.id;
END;
CREATE TRIGGER windows_credential_insert AFTER INSERT ON security_credentials BEGIN
  INSERT INTO security_windows_authority_versions VALUES('credential',NEW.credential_id,1)
  ON CONFLICT(kind,entity_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER windows_credential_change AFTER UPDATE ON security_credentials
WHEN OLD.status IS NOT NEW.status OR OLD.identity_id IS NOT NEW.identity_id
  OR OLD.public_key IS NOT NEW.public_key OR OLD.prf_enabled IS NOT NEW.prf_enabled BEGIN
  UPDATE security_windows_authority_versions SET revision=revision+1 WHERE kind='credential' AND entity_id=OLD.credential_id;
END;
CREATE TRIGGER windows_credential_delete AFTER DELETE ON security_credentials BEGIN
  UPDATE security_windows_authority_versions SET revision=revision+1 WHERE kind='credential' AND entity_id=OLD.credential_id;
END;
CREATE TRIGGER windows_link_insert AFTER INSERT ON security_service_links BEGIN
  INSERT INTO security_windows_authority_versions VALUES('link',NEW.id,1)
  ON CONFLICT(kind,entity_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER windows_link_change AFTER UPDATE ON security_service_links
WHEN OLD.status IS NOT NEW.status OR OLD.identity_id IS NOT NEW.identity_id
  OR OLD.service IS NOT NEW.service OR OLD.service_account_id IS NOT NEW.service_account_id
  OR OLD.cloud_root_folder_id IS NOT NEW.cloud_root_folder_id BEGIN
  UPDATE security_windows_authority_versions SET revision=revision+1 WHERE kind='link' AND entity_id=OLD.id;
END;
CREATE TRIGGER windows_link_delete AFTER DELETE ON security_service_links BEGIN
  UPDATE security_windows_authority_versions SET revision=revision+1 WHERE kind='link' AND entity_id=OLD.id;
END;
