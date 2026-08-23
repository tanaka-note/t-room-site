-- The first administrator may use the same Identity credential as either the
-- existing Cloud administrator or subadministrator. Subadministrator access
-- deliberately has no administrator PRF/private-key envelope: Cloud keeps its
-- existing folder-password crypto path and existing subadmin permissions.
INSERT OR IGNORE INTO security_service_links
  (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
SELECT
  'primary-admin-cloud-subadmin-v1',
  identity.id,
  'cloud',
  'subadmin',
  NULL,
  'T-Cloud 副管理者',
  CASE
    WHEN identity.status = 'active' AND EXISTS (
      SELECT 1 FROM security_credentials credential
      WHERE credential.identity_id = identity.id AND credential.status = 'active'
    ) THEN 'active'
    ELSE 'pending'
  END
FROM security_identities identity
WHERE identity.id = 'primary-admin'
  AND NOT EXISTS (
    SELECT 1 FROM security_service_links existing
    WHERE existing.identity_id = identity.id
      AND existing.service = 'cloud'
      AND existing.service_account_id = 'subadmin'
      AND existing.cloud_root_folder_id IS NULL
      AND existing.status IN ('pending', 'active')
  );
