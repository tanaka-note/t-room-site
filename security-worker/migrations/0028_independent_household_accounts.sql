-- Account existence/role is validated by the Household SecurityIntegration.
-- Retain the reserved first household owner and reject Cloud folder scopes.
-- Do not create Identity links or credentials; the owner assigns them in Security Center.
DROP TRIGGER household_account_guard;
DROP TRIGGER household_account_guard_update;
CREATE UNIQUE INDEX uq_household_editor_current
ON security_service_links(service_account_id)
WHERE service='household' AND service_account_id!='viewer' AND status IN ('pending','active');
CREATE TRIGGER household_account_guard BEFORE INSERT ON security_service_links
WHEN NEW.service='household'
BEGIN
  SELECT CASE WHEN NEW.service_account_id IS NULL
    OR length(NEW.service_account_id) NOT BETWEEN 1 AND 100
    OR NEW.cloud_root_folder_id IS NOT NULL
    OR (NEW.service_account_id='owner' AND NEW.identity_id!='primary-admin')
  THEN RAISE(ABORT,'household account required') END;
END;
CREATE TRIGGER household_account_guard_update
BEFORE UPDATE OF identity_id,service,service_account_id,cloud_root_folder_id ON security_service_links
WHEN NEW.service='household'
BEGIN
  SELECT CASE WHEN NEW.service_account_id IS NULL
    OR length(NEW.service_account_id) NOT BETWEEN 1 AND 100
    OR NEW.cloud_root_folder_id IS NOT NULL
    OR (NEW.service_account_id='owner' AND NEW.identity_id!='primary-admin')
  THEN RAISE(ABORT,'household account required') END;
END;
