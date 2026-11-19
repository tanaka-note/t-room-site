-- Explicit setup for the existing-photo migration. The normal D1 backup
-- captures canonical records and media, not in-progress work or leases.
CREATE TABLE diary_photo_migration_job (
 id INTEGER PRIMARY KEY CHECK(id=1), run TEXT NOT NULL, directory_generation INTEGER NOT NULL,
 control_generation INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('photos','records','ready','checking','done')),
 lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '', sequence INTEGER,
 retained_until INTEGER, restore_sha256 TEXT
);
CREATE TABLE diary_photo_migration_items (
 id TEXT PRIMARY KEY, household TEXT NOT NULL, source TEXT NOT NULL CHECK(json_valid(source)),
 metadata TEXT NOT NULL CHECK(json_valid(metadata)), parts TEXT NOT NULL CHECK(json_valid(parts)),
 verified INTEGER NOT NULL DEFAULT 0 CHECK(verified BETWEEN 0 AND 7)
);
CREATE TABLE diary_photo_migration_records (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))
);
