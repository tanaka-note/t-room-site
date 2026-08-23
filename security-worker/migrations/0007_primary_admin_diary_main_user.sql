-- The first administrator may use the same passkey Identity as either the
-- existing Diary administrator or the existing ordinary Diary account. Keep
-- the ordinary Identity link intact while allowing this one explicit alias;
-- every other current Diary/Billing account remains exclusive to one Identity.
DROP INDEX IF EXISTS uq_security_service_links_exclusive_current;

CREATE UNIQUE INDEX IF NOT EXISTS uq_security_service_links_exclusive_current
ON security_service_links(service, service_account_id)
WHERE service IN ('diary', 'billing')
  AND status IN ('pending', 'active')
  AND NOT (
    identity_id = 'primary-admin'
    AND service = 'diary'
    AND service_account_id = 'main-user'
  );

INSERT OR IGNORE INTO security_service_links
  (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
SELECT
  'primary-admin-diary-main-user-v1',
  identity.id,
  'diary',
  'main-user',
  NULL,
  '田中宏知（一般ユーザー）',
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
      AND existing.service = 'diary'
      AND existing.service_account_id = 'main-user'
      AND existing.cloud_root_folder_id IS NULL
      AND existing.status IN ('pending', 'active')
  );
