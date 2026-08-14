import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const style = readFileSync(`${root}/public/diary.css`, "utf8");

assert.match(html, /id="diary-date-from" type="date"/);
assert.match(html, /id="diary-date-to" type="date"/);
assert.match(html, /id="diary-date-reset"[^>]*>リセット<\/button>/);
assert.match(html, /id="tag-search-input"/);
assert.match(script, /parameters\.set\("dateFrom", state\.dateFrom\)/);
assert.match(script, /parameters\.set\("dateTo", state\.dateTo\)/);
assert.match(script, /bindDateInput\(elements\.entryDate\)/);
assert.match(script, /for \(const input of \[elements\.dateFrom, elements\.dateTo\]\)/);
assert.match(script, /elements\.dateReset\.addEventListener\("click", resetDateSearch\)/);
assert.match(script, /input\.addEventListener\("click", handleDateClick\)/);
assert.match(script, /function preventDateDirectInput\(event\) \{\s*event\.preventDefault\(\);\s*\}/);
assert.match(script, /function handleDateClick\(event\) \{[\s\S]*state\.nativeDatePickerTarget === event\.currentTarget[\s\S]*event\.preventDefault\(\);[\s\S]*openDateWheel\(event\.currentTarget\);/);
assert.doesNotMatch(script, /useMobileDateWheel/);
assert.match(script, /function openNativeDatePicker\(event\)[\s\S]*target\.showPicker\(\)/);
assert.doesNotMatch(script, /handleDatePointerDown|DATE_TAP_MAX_MOVEMENT_PX|DATE_TAP_MAX_DURATION_MS/);
assert.match(script, /includes\(state\.tagQuery\)/);
assert.match(style, /\.diary-search-box input::\-webkit-search-cancel-button,[\s\S]*?appearance: none;[\s\S]*?display: none;/);

process.stdout.write("Diary date and tag search UI contract test passed.\n");
