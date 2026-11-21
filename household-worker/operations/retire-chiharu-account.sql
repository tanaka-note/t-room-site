-- Run against household-db first. The independent household and its records
-- and recovery keys are retained for an explicitly approved return.
DELETE FROM household_accounts
WHERE id = 'chiharu-admin' AND household_id = 'chiharu' AND role = 'owner';
