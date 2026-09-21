import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
const migrationDirectory = new URL("../migrations/", import.meta.url);
const migrations = [
  "0001_init.sql", "0002_entry_authors.sql", "0003_investment_history.sql", "0004_entry_deletion_actor.sql",
  "0005_diary_photos.sql", "0006_login_attempts.sql", "0007_household_isolation.sql", "0008_chiharu_login_reset.sql",
  "0009_main_user.sql", "0010_entry_rich_text.sql", "0011_trash_scopes.sql", "0012_entry_drafts.sql",
  "0013_main_user_trash_and_media_retry.sql", "0014_diary_favorites.sql", "0015_photo_upload_staging.sql",
  "0016_entry_write_integrity.sql", "0017_diary_tag_order.sql", "0018_diary_weather.sql",
  "0019_password_auth_policy.sql", "0020_diary_entry_time.sql"
];
for (const migration of migrations) database.exec(await readFile(new URL(migration, migrationDirectory), "utf8"));

const insertEntry = database.prepare(`
  INSERT INTO diary_entries (entry_date, title, content, created_at, updated_at, deleted_at, revision, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
insertEntry.run("2026-09-01", "初回", "本文1", "2026-09-01 01:00:00", "2026-09-01 01:00:00", null, 1, "published");
insertEntry.run("2026-09-02", "編集済み", "本文2", "2026-09-02 01:00:00", "2026-09-03 02:30:00", null, 3, "published");
insertEntry.run("2026-09-03", "削除中", "本文3", "2026-09-03 01:00:00", "2026-09-04 03:00:00", "2026-09-04 03:00:00", 3, "published");
insertEntry.run("2026-09-04", "下書き", "本文4", "2026-09-04 01:00:00", "2026-09-05 04:00:00", null, 2, "draft");
database.prepare("INSERT INTO diary_tags (entry_id, tag, sort_order) VALUES (2, '維持', 0)").run();
database.prepare(`
  INSERT INTO diary_photos (
    id, entry_id, file_name, content_type, original_size, original_key, display_key, thumbnail_key,
    width, height, created_by_id, created_by_name
  ) VALUES ('11111111-1111-4111-8111-111111111111', 2, 'photo.jpg', 'image/jpeg', 123,
    'original-key', 'display-key', 'thumbnail-key', 800, 600, 'main-user', '利用者')
`).run();

const entryColumns = "id, entry_date, entry_time, title, content, created_at, updated_at, deleted_at, revision, status, weather";
const before = {
  entries: database.prepare(`SELECT ${entryColumns} FROM diary_entries ORDER BY id`).all(),
  tags: database.prepare("SELECT * FROM diary_tags ORDER BY entry_id, sort_order").all(),
  photos: database.prepare("SELECT * FROM diary_photos ORDER BY id").all()
};

database.exec(await readFile(new URL("0021_diary_last_published_at.sql", migrationDirectory), "utf8"));

const after = {
  entries: database.prepare(`SELECT ${entryColumns} FROM diary_entries ORDER BY id`).all(),
  tags: database.prepare("SELECT * FROM diary_tags ORDER BY entry_id, sort_order").all(),
  photos: database.prepare("SELECT * FROM diary_photos ORDER BY id").all()
};
assert.deepEqual(after, before, "backfill must not change diary content, dates, tags, photos, or existing metadata");
assert.deepEqual(
  database.prepare("SELECT id, last_published_at FROM diary_entries ORDER BY id").all().map((row) => ({ ...row })),
  [
    { id: 1, last_published_at: "2026-09-01T01:00:00.000Z" },
    { id: 2, last_published_at: "2026-09-03T02:30:00.000Z" },
    { id: 3, last_published_at: "2026-09-03T01:00:00.000Z" },
    { id: 4, last_published_at: null }
  ]
);

process.stdout.write("Diary last_published_at migration and non-destructive backfill tests passed.\n");
