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
  readFile(`${root}/migrations/0020_diary_entry_time.sql`, "utf8"),
  readFile(`${root}/public/manifest.webmanifest`, "utf8"),
  readFile(`${root}/../android-diary-twa/app/src/main/AndroidManifest.xml`, "utf8")
]);

assert.match(html, /class="entry-date-time-fields"[\s\S]*?for="entry-date">日付[\s\S]*?for="entry-time">時間/);
assert.match(html, /id="entry-time"[^>]*name="entryTime"[^>]*type="time"[^>]*step="60"/);
assert.match(style, /\.entry-date-time-fields\s*\{[\s\S]*?grid-template-columns:/);
assert.match(style, /@media \(max-width: 680px\)[\s\S]*?\.entry-date-time-fields/);
assert.match(script, /elements\.entryTime\.value = entry \? \(entry\.entryTime \|\| ""\) : japanTimeString\(\)/);
assert.match(script, /entryTime: elements\.entryTime\.value/);
assert.match(script, /time\.dateTime = entry\.entryTime \? `\$\{entry\.entryDate\}T\$\{entry\.entryTime\}` : entry\.entryDate/);
assert.match(script, /formatEntryDateTime\(entry\.entryDate, entry\.entryTime\)/);
assert.match(script, /timeZone: "Asia\/Tokyo"[\s\S]*?hourCycle: "h23"/);
assert.match(worker, /ORDER BY \$\{draft \? "e\.updated_at DESC, e\.id DESC" : "e\.entry_date DESC, e\.entry_time DESC, e\.id DESC"\}/);
assert.match(worker, /if \(body\.entryTime === undefined\) input\.entryTime = current\.entry_time \?\? null/);
assert.match(worker, /\^\(\?:\[01\]\\d\|2\[0-3\]\):\[0-5\]\\d\$/);
assert.match(worker, /if \(input\.entryTime != null\) payload\.entryTime = input\.entryTime/);
assert.match(backup, /const BACKUP_FORMAT_VERSION = 5/);
assert.match(backup, /"id", "entry_date", "entry_time"/);
assert.match(migration, /ADD COLUMN entry_time TEXT DEFAULT NULL/);
assert.match(migration, /entry_time GLOB '\[0-2\]\[0-9\]:\[0-5\]\[0-9\]'/);
assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|DROP)\b/i, "migration must not backfill or destructively modify existing entries");
assert.equal(JSON.parse(manifest).scope, "/diary/", "PWA continues to use the same UI");
assert.match(twaManifest, /https:\/\/tanaka-note\.com\/diary\/\?source=twa/, "TWA continues to launch the same Diary UI");

process.stdout.write("Diary entry time UI, API, migration, backup, PWA, and TWA contracts passed.\n");
