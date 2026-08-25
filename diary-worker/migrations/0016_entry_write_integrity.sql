ALTER TABLE diary_entries ADD COLUMN client_request_id TEXT;
ALTER TABLE diary_entries ADD COLUMN client_request_hash TEXT;
ALTER TABLE diary_entries ADD COLUMN last_mutation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_diary_entries_client_request
ON diary_entries(household_id, author_id, client_request_id)
WHERE client_request_id IS NOT NULL;
