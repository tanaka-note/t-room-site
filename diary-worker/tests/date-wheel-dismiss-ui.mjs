import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(script, /dateWheelDialog\.addEventListener\("click", closeDateWheelFromBackdrop\)/);
assert.match(script, /function closeDateWheelFromBackdrop\(event\) \{\s*if \(event\.target === elements\.dateWheelDialog\) closeDateWheel\(\);\s*\}/);
assert.match(script, /column\.addEventListener\("wheel", \(event\) => \{/);
assert.match(script, /event\.preventDefault\(\);/);
assert.match(script, /wheelTargetIndex \+ \(event\.deltaY > 0 \? 1 : -1\)/);
assert.match(script, /\}, \{ passive: false \}\);/);

process.stdout.write("Diary date wheel dismissal and one-step mouse scrolling contract test passed.\n");
