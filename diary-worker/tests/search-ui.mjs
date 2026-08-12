import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(html, /id="diary-date-from" type="date"/);
assert.match(html, /id="diary-date-to" type="date"/);
assert.match(html, /id="tag-search-input"/);
assert.match(script, /parameters\.set\("dateFrom", state\.dateFrom\)/);
assert.match(script, /parameters\.set\("dateTo", state\.dateTo\)/);
assert.match(script, /bindDateInput\(elements\.entryDate\)/);
assert.match(script, /for \(const input of \[elements\.dateFrom, elements\.dateTo\]\)/);
assert.match(script, /includes\(state\.tagQuery\)/);

process.stdout.write("Diary date and tag search UI contract test passed.\n");
