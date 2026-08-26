ALTER TABLE diary_tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0);

WITH ranked_tags AS (
  SELECT
    rowid AS tag_rowid,
    ROW_NUMBER() OVER (
      PARTITION BY entry_id
      ORDER BY rowid
    ) - 1 AS calculated_sort_order
  FROM diary_tags
)
UPDATE diary_tags
SET sort_order = (
  SELECT calculated_sort_order
  FROM ranked_tags
  WHERE ranked_tags.tag_rowid = diary_tags.rowid
);
