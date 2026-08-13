import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const functionMatch = script.match(/function handleDateClick\(event\) \{[\s\S]*?\n  \}\n\n  function handleDateKeydown/);

assert.ok(functionMatch, "handleDateClick must exist immediately before handleDateKeydown");
const functionSource = functionMatch[0].replace(/\n\n  function handleDateKeydown$/, "");

function executeClick({ mobile }) {
  const calls = { prevented: 0, openedWith: null };
  const context = {
    useMobileDateWheel: () => mobile,
    openDateWheel: (target) => { calls.openedWith = target; }
  };
  vm.runInNewContext(`${functionSource}; globalThis.testHandleDateClick = handleDateClick;`, context);
  const target = { id: "date-input" };
  context.testHandleDateClick({
    currentTarget: target,
    preventDefault: () => { calls.prevented += 1; }
  });
  return { calls, target };
}

const desktop = executeClick({ mobile: false });
assert.equal(desktop.calls.prevented, 0, "desktop native date behavior must not be cancelled");
assert.equal(desktop.calls.openedWith, null, "desktop must keep its native date picker");

const mobile = executeClick({ mobile: true });
assert.equal(mobile.calls.prevented, 1, "mobile must cancel only the native picker after a confirmed click");
assert.equal(mobile.calls.openedWith, mobile.target, "mobile must open the shared date wheel for the tapped input");

assert.match(script, /for \(const input of \[elements\.dateFrom, elements\.dateTo\]\) \{\s*bindDateInput\(input\);/);
assert.match(script, /bindDateInput\(elements\.entryDate\)/);

process.stdout.write("Diary mobile and desktop date input behavior test passed.\n");
