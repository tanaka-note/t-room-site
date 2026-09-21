import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, style, worker, backup, migration, manifest, twaManifest] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/src/backup.js`, "utf8"),
  readFile(`${root}/migrations/0021_diary_last_published_at.sql`, "utf8"),
  readFile(`${root}/public/manifest.webmanifest`, "utf8"),
  readFile(`${root}/../android-diary-twa/app/src/main/AndroidManifest.xml`, "utf8")
]);

assert.match(html, /class="entry-date-field"[\s\S]*?for="entry-date">日付/);
assert.doesNotMatch(html, /id="entry-time"|name="entryTime"|for="entry-time">時間/);
assert.match(html, /id="detail-date"[^>]*entry-date-primary/);
assert.match(html, /id="detail-published-at"[^>]*entry-published-at/);
assert.match(style, /\.entry-date-primary\s*\{[\s\S]*?font-size:\s*1rem/);
assert.match(style, /\.entry-published-at\s*\{[\s\S]*?font-size:\s*0\.74rem/);
assert.doesNotMatch(style, /#entry-time|entry-date-time-fields/);

assert.match(script, /date\.dateTime = entry\.entryDate;[\s\S]*?date\.textContent = formatDate\(entry\.entryDate\)/);
assert.match(script, /publishedAt\.textContent = `投稿日時：\$\{formatPublishedDateTime\(entry\.lastPublishedAt\)\}`/);
assert.match(script, /elements\.detailDate\.textContent = formatDate\(entry\.entryDate\)/);
assert.match(script, /timeZone: "Asia\/Tokyo"[\s\S]*?hourCycle: "h23"/);
assert.doesNotMatch(script, /elements\.entryTime|entryTime:\s*elements|formatEntryDateTime|japanTimeString/);
assert.doesNotMatch(script, /entryMatchesEditorPayload[\s\S]*?entry\.entryTime/);

assert.match(worker, /ORDER BY \$\{draft \? "e\.updated_at DESC, e\.id DESC" : "e\.entry_date DESC, e\.last_published_at DESC, e\.id DESC"\}/);
assert.match(worker, /last_published_at = CASE WHEN \? = 'published' THEN strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/);
assert.match(worker, /last_published_at = strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/);
assert.match(worker, /const accepted = new Set\(\[primary\]\);[\s\S]*?accepted\.add\(await entryRequestPayloadHash\(\{ \.\.\.payload, entryTime: legacyEntryTime \}\)\)/,
  "retries created by the previous entryTime-aware hash remain compatible across deployment");
assert.doesNotMatch(worker, /normalizeEntryTime|payload\.entryTime|input\.entryTime|row\.entry_time/);

assert.match(backup, /const BACKUP_FORMAT_VERSION = 6/);
assert.match(backup, /"id", "entry_date", "last_published_at", "entry_time"/);
assert.match(backup, /\[LEGACY_BACKUP_FORMAT_VERSION, 3, 4, 5, BACKUP_FORMAT_VERSION\]/);
assert.match(migration, /ADD COLUMN last_published_at TEXT DEFAULT NULL/);
assert.match(migration, /WHEN revision <= 1 OR updated_at = created_at THEN strftime/);
assert.match(migration, /WHEN deleted_at IS NOT NULL AND updated_at = deleted_at THEN strftime\('%Y-%m-%dT%H:%M:%fZ', created_at\)/);
assert.match(migration, /entry_date DESC, last_published_at DESC, id DESC/);
assert.doesNotMatch(migration, /\b(?:DELETE|DROP)\b/i, "migration must not delete diary data or schema");

assert.equal(JSON.parse(manifest).scope, "/diary/", "PWA continues to use the same UI");
assert.match(twaManifest, /https:\/\/tanaka-note\.com\/diary\/\?source=twa/, "TWA continues to launch the same Diary UI");

process.stdout.write("Diary date/publication timestamp UI, API, migration, backup, PWA, and TWA contracts passed.\n");
