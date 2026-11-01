-- Allow explicitly approved Identities to use the same household account.
-- Keep one current link per Identity/account; disabled link IDs stay revoked.
-- The existing owner guard still reserves the original owner for primary-admin.
DROP INDEX uq_household_editor_current;
CREATE UNIQUE INDEX uq_household_identity_account_current
ON security_service_links(identity_id, service_account_id)
WHERE service='household' AND status IN ('pending','active');
