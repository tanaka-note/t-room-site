import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(script, /dateWheelDialog\.addEventListener\("click", closeDateWheelFromBackdrop\)/);
assert.match(script, /function closeDateWheelFromBackdrop\(event\) \{\s*if \(event\.target === elements\.dateWheelDialog\) closeDateWheel\(\);\s*\}/);

process.stdout.write("Diary date wheel backdrop dismissal contract test passed.\n");
