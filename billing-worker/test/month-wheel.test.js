import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("invoice month field keeps the bottom wheel and uses the shared T-ROOM calendar", async () => {
  const [html, script, styles, pickerScript, pickerStyles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.css", import.meta.url), "utf8"),
    readFile(new URL("../public/troom-date-picker.js", import.meta.url), "utf8"),
    readFile(new URL("../public/troom-date-picker.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="month-input" type="text"[^>]*readonly[^>]*pattern="\\d\{4\}-\\d\{2\}"[^>]*aria-controls="date-wheel-dialog"/);
  assert.match(html, /id="month-picker-button"[^>]*data-date-picker-target="month-input"[^>]*data-date-picker-mode="month"/);
  assert.match(html, /troom-date-picker\.css\?v=1/);
  assert.match(html, /troom-date-picker\.js\?v=1/);
  assert.match(html, /id="date-wheel-day-group"/);
  assert.match(script, /bindMonthInput\(el\["month-input"\]\)/);
  assert.match(script, /openDateWheel\(event\.currentTarget, "month"\)/);
  assert.match(script, /el\["date-wheel-day-group"\]\.hidden = isMonth/);
  assert.match(script, /el\["date-wheel-window"\]\.classList\.toggle\("is-month-only", isMonth\)/);
  assert.match(script, /column\.addEventListener\("wheel", \(event\) => \{/);
  assert.match(script, /const visibleIndex = clamp\(Math\.round\(column\.scrollTop \/ 44\), 0, options\.length - 1\)/);
  assert.match(script, /column\.scrollTop = clamp\(visibleIndex \+ direction, 0, options\.length - 1\) \* 44/);
  assert.match(script, /isMonth \? datePartsToMonth\(state\.dateDraft\) : datePartsToString\(state\.dateDraft\)/);
  assert.match(script, /if \(isMonth\) target\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(styles, /\.date-wheel-window\.is-month-only\s*\{\s*grid-template-columns:\s*1\.35fr 1fr;/);
  assert.match(pickerScript, /const BUTTON_SELECTOR = "\[data-date-picker-target\]\[data-date-picker-mode\]"/);
  assert.match(pickerScript, /state\.mode === "month"/);
  assert.match(pickerScript, /for \(let month = 1; month <= 12; month \+= 1\)/);
  assert.match(pickerStyles, /\.troom-calendar-dialog\[data-mode="month"\] \.troom-calendar-grid/);
  assert.equal((html.match(/class="date-picker-button"/g) || []).length, 2);
  assert.doesNotMatch(html, /type="(?:date|month)"/);
  assert.doesNotMatch(script, /showPicker|openNativeDatePicker|nativeDatePickerTarget|monthCalendar/);
  assert.doesNotMatch(styles, /calendar-picker-indicator|month-calendar/);
  assert.doesNotMatch(html, /id="month-calendar-dialog"/);
});

test("entry dates retain the existing year-month-day wheel and YYYY-MM-DD value", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="entry-date" type="text"[^>]*readonly[^>]*required[^>]*pattern="\\d\{4\}-\\d\{2\}-\\d\{2\}"/);
  assert.match(html, /id="entry-date-picker-button"[^>]*data-date-picker-target="entry-date"[^>]*data-date-picker-mode="date"/);
  assert.match(html, /id="date-wheel-day"[^>]*aria-label="日"/);
  assert.match(script, /bindDateInput\(el\["entry-date"\]\)/);
  assert.match(script, /function handleDateClick\(event\)[\s\S]*openDateWheel\(event\.currentTarget, "date"\)/);
  assert.match(script, /function datePartsToString\(\{ year, month, day \}\)/);
  assert.match(script, /entryDate = el\["entry-date"\]\.value/);
});
