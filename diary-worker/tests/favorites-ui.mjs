import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, css, script, worker, migration] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/migrations/0014_diary_favorites.sql`, "utf8")
]);

assert.match(migration, /CREATE TABLE IF NOT EXISTS diary_favorites/);
assert.match(migration, /PRIMARY KEY \(account_id, entry_id\)/);
assert.match(migration, /FOREIGN KEY \(entry_id\) REFERENCES diary_entries\(id\) ON DELETE CASCADE/);
assert.doesNotMatch(migration, /REFERENCES diary_accounts/);

assert.match(html, /href="\/diary\/favorites\/"/);
assert.match(html, /お気に入り/);
assert.match(html, /id="favorite-entry-button"[^>]*aria-pressed="false"[^>]*aria-label="お気に入りに追加"[^>]*title="お気に入りに追加"/);
assert.match(html, /id="favorite-entry-button"[\s\S]*?<svg[\s\S]*?<path/);
assert.match(html, /data-close-dialog="entry-dialog"/);

assert.match(css, /\.favorite-entry-button\[aria-pressed="true"\][\s\S]*?fill: #e2b52a/);
assert.match(css, /\.favorite-entry-button:hover[\s\S]*?\.favorite-entry-button:focus-visible/);
assert.match(css, /\.dialog-head-actions/);

assert.match(worker, /favoriteMatch = path\.match/);
assert.match(worker, /session\.activeHouseholdId/);
assert.match(worker, /session\.accountId/);
assert.match(worker, /searchParams\.get\("favorite"\)/);
assert.match(worker, /isFavorite: Number\(row\.is_favorite \|\| 0\) === 1/);

assert.match(script, /\/entries\/\$\{entry\.id\}\/favorite/);
assert.match(script, /state\.favoriteRequestPending/);
assert.match(script, /state\.favoritePage/);
assert.match(script, /state\.entries = state\.entries\.filter\(\(item\) => item\.id !== entry\.id\);[\s\S]{0,220}state\.offset = state\.entries\.length;/);
assert.match(script, /parameters\.set\("favorite", "1"\)/);
assert.ok(script.includes("const onFavoritePage = /^\\/diary\\/favorites\\/?$/.test"));
assert.match(script, /elements\.entryDialog\.showModal\(\);\s*pushEntryHistory\(\);/);
assert.match(script, /window\.addEventListener\("popstate", handleHistoryNavigation\)/);
assert.match(script, /お気に入りの日記はまだありません。/);

process.stdout.write("Diary favorite UI, route, history, and auto-update-safe client contracts passed.\n");
