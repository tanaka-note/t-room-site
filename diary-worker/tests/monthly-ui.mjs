import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const worker = readFileSync(`${root}/src/index.js`, "utf8");

assert.match(html, /id="current-month-button"/);
assert.match(html, /id="diary-recent-title">今月の投稿<\/h2>/);
assert.match(html, /id="previous-month-button"[^>]*>前月<\/button>/);
assert.match(html, /id="next-month-button"[^>]*>翌月<\/button>/);
assert.match(html, /id="load-more-button"[^>]*>もっと見る<\/button>/);
assert.match(script, /month: japanDateString\(\)\.slice\(0, 7\)/);
assert.match(script, /const pageSize = monthlyView \? \(state\.monthExpanded \? 50 : 5\) : 20/);
assert.match(script, /while \(monthlyView && state\.monthExpanded && hasMore/);
assert.match(script, /state\.monthExpanded = true;\s*loadEntries\(true\)/);
assert.match(script, /elements\.listTitle\.textContent = state\.month === currentJapanMonth\(\)[\s\S]*?"今月の投稿"/);
assert.match(script, /return year === currentYear \? `\$\{month\}月の投稿` : `\$\{year\}年\$\{month\}月の投稿`/);
assert.match(script, /\? "記事なし"/);
assert.match(script, /function changeBrowseMonth\(offset\)/);
assert.match(script, /function returnToCurrentMonth\(\)[\s\S]*?state\.month = currentJapanMonth\(\);[\s\S]*?loadEntries\(true\)/);
assert.match(script, /elements\.currentMonth\.disabled = state\.month === currentJapanMonth\(\)/);
assert.doesNotMatch(script, /nextMonth > currentJapanMonth\(\)/);
assert.match(worker, /ORDER BY e\.entry_date DESC, e\.id DESC/);

process.stdout.write("Diary monthly entry-date-descending list contract test passed.\n");
