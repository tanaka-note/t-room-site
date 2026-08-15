import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const style = readFileSync(`${root}/public/diary.css`, "utf8");
const pickerScript = readFileSync(`${root}/public/troom-date-picker.js`, "utf8");
const pickerStyle = readFileSync(`${root}/public/troom-date-picker.css`, "utf8");
const functionMatch = script.match(/function handleDateClick\(event\) \{[\s\S]*?\n  \}\n\n  function handleDateKeydown/);

assert.ok(functionMatch, "handleDateClick must exist immediately before handleDateKeydown");
const functionSource = functionMatch[0].replace(/\n\n  function handleDateKeydown$/, "");
const calls = { prevented: 0, blurred: 0, openedWith: null };
const target = { id: "date-input", blur: () => { calls.blurred += 1; } };
const context = { openDateWheel: (value) => { calls.openedWith = value; } };
vm.runInNewContext(`${functionSource}; globalThis.testHandleDateClick = handleDateClick;`, context);
context.testHandleDateClick({
  currentTarget: target,
  preventDefault: () => { calls.prevented += 1; }
});

assert.equal(calls.prevented, 1, "field clicks must continue to open the bottom wheel");
assert.equal(calls.blurred, 1, "field clicks must keep the non-editable input unfocused");
assert.equal(calls.openedWith, target, "the existing wheel must receive the tapped input");
assert.match(script, /for \(const input of \[elements\.dateFrom, elements\.dateTo\]\) \{\s*bindDateInput\(input\);/);
assert.match(script, /bindDateInput\(elements\.entryDate\)/);
assert.equal((html.match(/data-date-picker-target=/g) || []).length, 3);
assert.equal((html.match(/data-date-picker-mode="date"/g) || []).length, 3);
assert.equal((html.match(/type="text" inputmode="none" readonly[^>]*pattern="\\d\{4\}-\\d\{2\}-\\d\{2\}"/g) || []).length, 3);
assert.match(pickerScript, /button\.addEventListener\("click", openFromButton\)/);
assert.match(pickerScript, /target\.dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/);
assert.match(pickerScript, /target\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
assert.match(pickerStyle, /\.troom-calendar-weekdays/);
assert.match(pickerStyle, /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
assert.match(pickerStyle, /\.date-picker-button \{/);
assert.match(pickerStyle, /padding-right: 52px/);
assert.doesNotMatch(html, /type="date"|type="month"/);
assert.doesNotMatch(script, /showPicker|openNativeDatePicker|nativeDatePickerTarget/);
assert.doesNotMatch(style, /calendar-picker-indicator|date-picker-button|date-input-shell/);

process.stdout.write("Diary shared calendar and bottom wheel input contract test passed.\n");
