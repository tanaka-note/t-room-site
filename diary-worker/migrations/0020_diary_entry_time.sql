ALTER TABLE diary_entries
ADD COLUMN entry_time TEXT DEFAULT NULL
  CHECK (
    entry_time IS NULL OR (
      entry_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND substr(entry_time, 1, 2) BETWEEN '00' AND '23'
    )
  );

CREATE INDEX IF NOT EXISTS idx_diary_entries_household_datetime
ON diary_entries(household_id, status, deleted_at, entry_date DESC, entry_time DESC, id DESC);
