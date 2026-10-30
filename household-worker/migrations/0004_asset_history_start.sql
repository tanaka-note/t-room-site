-- User-requested asset-history start: keep 2022-06-30 and later.
-- Bump the active revision before removing records so stale clients cannot restore them.
UPDATE household_state SET revision=revision+1
WHERE id='main' AND EXISTS (
  SELECT 1 FROM household_records
  WHERE dataset_id=household_state.active_dataset AND kind IN ('historical','snapshots')
    AND (id<'2022-06' OR json_extract(payload,'$.month')<'2022-06'
      OR json_extract(payload,'$.date')<'2022-06-30')
);

-- Include inactive restore generations; this is a physical deletion, not a view filter.
DELETE FROM household_records
WHERE kind IN ('historical','snapshots')
  AND (id<'2022-06' OR json_extract(payload,'$.month')<'2022-06'
    OR json_extract(payload,'$.date')<'2022-06-30');

CREATE TRIGGER household_asset_cutoff_insert BEFORE INSERT ON household_records
WHEN NEW.kind IN ('historical','snapshots')
  AND (NEW.id<'2022-06' OR json_extract(NEW.payload,'$.month')<'2022-06'
    OR json_extract(NEW.payload,'$.date')<'2022-06-30')
BEGIN SELECT RAISE(ABORT,'household_asset_history_before_start'); END;

CREATE TRIGGER household_asset_cutoff_update BEFORE UPDATE ON household_records
WHEN NEW.kind IN ('historical','snapshots')
  AND (NEW.id<'2022-06' OR json_extract(NEW.payload,'$.month')<'2022-06'
    OR json_extract(NEW.payload,'$.date')<'2022-06-30')
BEGIN SELECT RAISE(ABORT,'household_asset_history_before_start'); END;
