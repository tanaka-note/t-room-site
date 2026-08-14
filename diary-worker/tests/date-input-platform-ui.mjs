import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(`${root}/public/index.html`, "utf8");
const script = readFileSync(`${root}/public/diary.js`, "utf8");
const style = readFileSync(`${root}/public/diary.css`, "utf8");
const functionMatch = script.match(/function handleDateClick\(event\) \{[\s\S]*?\n  \}\n\n  function handleDateKeydown/);

assert.ok(functionMatch, "handleDateClick must exist immediately before handleDateKeydown");
const functionSource = functionMatch[0].replace(/\n\n  function handleDateKeydown$/, "");

function executeClick({ native = false }) {
  const calls = { prevented: 0, blurred: 0, openedWith: null };
  const target = { id: "date-input", blur: () => { calls.blurred += 1; } };
  const context = {
    state: { nativeDatePickerTarget: native ? target : null },
    openDateWheel: (target) => { calls.openedWith = target; }
  };
  vm.runInNewContext(`${functionSource}; globalThis.testHandleDateClick = handleDateClick;`, context);
  context.testHandleDateClick({
    currentTarget: target,
    preventDefault: () => { calls.prevented += 1; }
  });
  return { calls, target };
}

const desktop = executeClick({});
assert.equal(desktop.calls.prevented, 1, "desktop field clicks must open the shared date wheel");
assert.equal(desktop.calls.blurred, 1, "desktop field clicks must clear the native blue segment selection");
assert.equal(desktop.calls.openedWith, desktop.target, "desktop must open the same date wheel as mobile");

const mobile = executeClick({});
assert.equal(mobile.calls.prevented, 1, "mobile field clicks must open the shared date wheel");
assert.equal(mobile.calls.blurred, 1, "mobile field clicks must leave only the picker UI active");
assert.equal(mobile.calls.openedWith, mobile.target, "mobile must open the shared date wheel for the tapped input");

const mobileCalendarButton = executeClick({ native: true });
assert.equal(mobileCalendarButton.calls.prevented, 0, "the explicit calendar button must bypass the bottom date wheel");
assert.equal(mobileCalendarButton.calls.openedWith, null, "the explicit calendar button must preserve the native calendar picker");

assert.match(script, /for \(const input of \[elements\.dateFrom, elements\.dateTo\]\) \{\s*bindDateInput\(input\);/);
assert.match(script, /bindDateInput\(elements\.entryDate\)/);
assert.equal((html.match(/data-date-picker-target=/g) || []).length, 3,
  "entry date and both search dates must expose their own calendar buttons");
assert.match(script, /datePickerButtons\.forEach\(\(button\) => button\.addEventListener\("click", openNativeDatePicker\)\)/);
assert.match(script, /function openNativeDatePicker\(event\)[\s\S]*target\.showPicker\(\)/);
assert.doesNotMatch(script, /function openNativeDatePicker\(event\)[\s\S]*target\.focus\(/,
  "the explicit calendar button must not leave a blue date segment selected");
assert.match(script, /input\.addEventListener\("beforeinput", preventDateDirectInput\)/);
assert.match(script, /input\.addEventListener\("paste", preventDateDirectInput\)/);
assert.match(style, /\.date-picker-button \{[\s\S]*position: absolute;/);
assert.match(style, /\.date-input-shell > input \{[\s\S]*padding-right: 8px;[\s\S]*appearance: none;[\s\S]*-webkit-appearance: none;/,
  "Firefox must keep its native date indicator underneath the explicit calendar button");
assert.match(style, /@supports selector\(input::\-webkit-calendar-picker-indicator\)[\s\S]*padding-right: 52px;/,
  "Chromium and WebKit must preserve room for the explicit calendar button after hiding their native indicator");
assert.match(style, /::-webkit-calendar-picker-indicator \{[\s\S]*display: none;/,
  "WebKit and Chromium must not render a second calendar icon");
assert.match(style, /\.date-picker-button \{[\s\S]*z-index: 1;/,
  "the explicit button must cover Firefox's non-styleable native date indicator");
assert.match(style, /\.date-input-shell > input \{[\s\S]*color: #7a8490;[\s\S]*user-select: none;/,
  "dates must look like non-editable examples instead of active blue text segments");
assert.match(style, /@media \(pointer: coarse\)[\s\S]*#entry-date \{\s*touch-action: manipulation;/,
  "mobile date inputs must recognize a deliberate tap instead of disabling the calendar action");

process.stdout.write("Diary mobile and desktop date input behavior test passed.\n");
