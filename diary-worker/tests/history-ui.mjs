import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8")
]);

assert.match(html, /diary\.js\?v=52/);
assert.match(script, /const ENTRY_HISTORY_KEY = "troomDiaryEntry"/);
assert.match(script, /elements\.entryDialog\.showModal\(\);\s*pushEntryHistory\(\);/);
assert.match(script, /window\.history\.pushState\(/);
const pushEntryHistoryBody = script.match(/function pushEntryHistory\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
assert.doesNotMatch(pushEntryHistoryBody, /searchInput\.value|dateFrom\.value|dateTo\.value|tagSearchInput\.value/);
assert.match(script, /if \(state\.entryClosePending\) return/);
assert.match(script, /state\.entryClosePending = true;\s*window\.history\.back\(\);/s);
assert.match(script, /window\.addEventListener\("popstate", handleHistoryNavigation\)/);
assert.match(script, /function handleHistoryNavigation\(\) \{[^}]*finishEntryClose\(\);/s);
assert.match(script, /elements\.entryDialog\.addEventListener\("cancel", \(event\) => \{\s*event\.preventDefault\(\);\s*closeEntryDialog\(\);/s);
assert.match(script, /elements\.entryDialog\.addEventListener\("click", closeEntryFromDesktopBackdrop\)/);
assert.match(script, /function closeEntryFromDesktopBackdrop\(event\) \{\s*if \(event\.target !== elements\.entryDialog\) return;\s*if \(!window\.matchMedia\("\(min-width: 861px\) and \(hover: hover\) and \(pointer: fine\)"\)\.matches\) return;\s*closeEntryDialog\(\);\s*\}/s);
assert.match(script, /if \(id === "entry-dialog"\) \{\s*closeEntryDialog\(\);/s);

process.stdout.write("Diary entry history behavior test passed.\n");
