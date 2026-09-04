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
assert.match(script, /async function handleLoadMore\(\)[\s\S]*?state\.monthExpanded = true;[\s\S]*?await loadEntries\(false\);[\s\S]*?restoreEntryListPosition\(position\)/);
assert.match(script, /function captureEntryListPosition\(\)/);
assert.match(script, /function restoreEntryListPosition\(position\)/);
assert.match(script, /anchor\.getBoundingClientRect\(\)\.top - position\.top/);
assert.match(script, /const canAppend = appendFrom > 0 && existingCardCount === appendFrom/);
assert.match(script, /elements\.entryList\.append\(\.\.\.cards\)/);
assert.match(script, /elements\.listTitle\.textContent = state\.month === currentJapanMonth\(\)[\s\S]*?"今月の投稿"/);
assert.match(script, /return year === currentYear \? `\$\{month\}月の投稿` : `\$\{year\}年\$\{month\}月の投稿`/);
assert.match(script, /\? "記事なし"/);
assert.match(script, /function changeBrowseMonth\(offset\)/);
assert.match(script, /async function handleArchiveClick\(event\)[\s\S]*?if \(alreadyShowingMonth\) \{\s*await scrollToMonthlyHeadingAfterRender\(targetMonth\);\s*return;\s*\}[\s\S]*?state\.monthExpanded = false;[\s\S]*?await loadEntries\(true\);[\s\S]*?await scrollToMonthlyHeadingAfterRender\(targetMonth\);/);
assert.match(script, /function scrollToMonthlyHeadingAfterRender\(targetMonth\)[\s\S]*?window\.requestAnimationFrame[\s\S]*?window\.requestAnimationFrame[\s\S]*?elements\.listTitle\.getBoundingClientRect\(\)\.top[\s\S]*?window\.scrollTo\(/);
assert.match(script, /function returnToCurrentMonth\(\)[\s\S]*?state\.month = currentJapanMonth\(\);[\s\S]*?loadEntries\(true\)/);
assert.match(script, /elements\.currentMonth\.disabled = state\.month === currentJapanMonth\(\)/);
assert.doesNotMatch(script, /nextMonth > currentJapanMonth\(\)/);
assert.match(worker, /draft \? "e\.updated_at DESC, e\.id DESC" : "e\.entry_date DESC, e\.id DESC"/);

process.stdout.write("Diary monthly entry-date-descending list contract test passed.\n");
