import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(`${root}/public/diary.js`, "utf8");

assert.match(script, /dateWheelDialog\.addEventListener\("click", applyDateWheelFromBackdrop\)/);
assert.match(script, /function applyDateWheelFromBackdrop\(event\) \{\s*if \(event\.target === elements\.dateWheelDialog\) applyDateWheel\(\);\s*\}/);
const backdropSource = script.match(/function applyDateWheelFromBackdrop\(event\) \{[\s\S]*?\n  \}/)?.[0] || "";
assert.ok(backdropSource);
const dialog = {};
let applyCount = 0;
const backdropContext = { elements: { dateWheelDialog: dialog }, applyDateWheel: () => { applyCount += 1; } };
vm.runInNewContext(`${backdropSource}; globalThis.handleBackdrop = applyDateWheelFromBackdrop;`, backdropContext);
backdropContext.handleBackdrop({ target: {} });
assert.equal(applyCount, 0, "clicks inside the diary wheel must not apply or close it");
backdropContext.handleBackdrop({ target: dialog });
assert.equal(applyCount, 1, "one diary backdrop click must run the shared apply action exactly once");
assert.match(script, /column\.addEventListener\("wheel", \(event\) => \{/);
assert.match(script, /state\.dateDraft\[key\] = value;[\s\S]*updateDateWheelValue\(\);[\s\S]*column\.scrollTo\(\{ top: Number\(option\.dataset\.index\) \* 44, behavior: "smooth" \}\);/);
assert.match(script, /event\.preventDefault\(\);/);
assert.match(script, /const direction = event\.deltaY > 0 \? 1 : -1;/);
assert.match(script, /column\.scrollTop = clamp\(visibleIndex \+ direction, 0, options\.length - 1\) \* 44;/);
assert.doesNotMatch(script, /Math\.abs\(wheelTargetIndex - visibleIndex\)/);
assert.match(script, /\}, \{ passive: false \}\);/);
assert.match(script, /column\.dataset\.settingScroll = "true"/);
assert.match(script, /if \(column\.dataset\.settingScroll === "true"\) return;/,
  "programmatic initial positioning must not overwrite the selected date");

process.stdout.write("Diary date wheel dismissal and exact one-step mouse scrolling contract test passed.\n");
