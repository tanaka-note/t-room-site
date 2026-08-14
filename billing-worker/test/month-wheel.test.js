import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("invoice month field reuses the bottom wheel without a day selector", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="month-input" type="month"[^>]*aria-controls="date-wheel-dialog"/);
  assert.match(html, /id="month-picker-button" class="date-picker-button"[^>]*data-date-picker-target="month-input"[^>]*aria-label="表示月をカレンダーから選ぶ"/);
  assert.match(html, /id="date-wheel-day-group"/);
  assert.match(script, /bindMonthInput\(el\["month-input"\]\)/);
  assert.match(script, /el\["month-picker-button"\]\.addEventListener\("click", openNativeDatePicker\)/);
  assert.match(script, /function openNativeDatePicker\(event\)[\s\S]*target\.showPicker\(\)/);
  assert.match(script, /target\.getAttribute\("type"\) === "month" && target\.type !== "month"/,
    "browsers without native month inputs must use the real month-calendar fallback");
  assert.match(script, /openMonthCalendar\(target\)/);
  assert.match(script, /state\.nativeDatePickerTarget === event\.currentTarget/);
  assert.match(script, /openDateWheel\(event\.currentTarget, "month"\)/);
  assert.match(script, /el\["date-wheel-day-group"\]\.hidden = isMonth/);
  assert.match(script, /el\["date-wheel-window"\]\.classList\.toggle\("is-month-only", isMonth\)/);
  assert.match(script, /column\.addEventListener\("wheel", \(event\) => \{/);
  assert.match(script, /const visibleIndex = clamp\(Math\.round\(column\.scrollTop \/ 44\), 0, options\.length - 1\)/);
  assert.match(script, /column\.scrollTop = clamp\(visibleIndex \+ direction, 0, options\.length - 1\) \* 44/);
  assert.match(script, /\}, \{ passive: false \}\)/);
  assert.match(script, /column\.dataset\.settingScroll = "true"/);
  assert.match(script, /if \(column\.dataset\.settingScroll === "true"\) return/);
  assert.match(script, /column\.scrollTo\(\{ top: Number\(option\.dataset\.index\) \* 44, behavior: "smooth" \}\)/);
  assert.match(script, /isMonth \? datePartsToMonth\(state\.dateDraft\) : datePartsToString\(state\.dateDraft\)/);
  assert.match(script, /if \(isMonth\) target\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(styles, /\.date-wheel-window\.is-month-only\s*\{\s*grid-template-columns:\s*1\.35fr 1fr;/);
  assert.match(styles, /\.date-picker-button\s*\{[^}]*right:\s*5px;[^}]*width:\s*38px;[^}]*height:\s*38px;/s);
  assert.match(styles, /\.date-picker-button\s*\{[^}]*z-index:\s*1;/s);
  assert.match(styles, /\.date-input-shell > input\s*\{[^}]*padding-right:\s*8px;/s);
  assert.match(styles, /@supports selector\(input::\-webkit-calendar-picker-indicator\)\s*\{[^}]*\.date-input-shell > input\s*\{[^}]*padding-right:\s*52px;/s);
  assert.match(styles, /::-webkit-calendar-picker-indicator\s*\{[^}]*display:\s*none;/s);
  assert.equal((html.match(/class="date-picker-button"/g) || []).length, 2,
    "only one explicit native-calendar button must be shown for each date field");
  const nativePickerSource = script.match(/function openNativeDatePicker\(event\)\s*\{[\s\S]*?\n  \}\n\n  function preventMonthDirectInput/)?.[0] || "";
  assert.ok(nativePickerSource, "native calendar picker handler must exist");
  assert.doesNotMatch(nativePickerSource, /openDateWheel\(/,
    "the calendar buttons must not open the bottom wheel");
  assert.match(html, /id="month-calendar-dialog" class="month-calendar-dialog"/);
  assert.equal((html.match(/id="month-calendar-dialog"/g) || []).length, 1,
    "the Firefox month fallback calendar must exist exactly once");

  const pickerHandler = script.match(/function openNativeDatePicker\(event\) \{[\s\S]*?\n  \}\n\n  function openMonthCalendar/)?.[0]
    .replace(/\n\n  function openMonthCalendar$/, "") || "";
  assert.ok(pickerHandler);
  const firefoxMonth = {
    type: "text",
    getAttribute: (name) => name === "type" ? "month" : null,
    showPicker: () => { throw new Error("Firefox month must not call showPicker"); }
  };
  let fallbackTarget = null;
  const firefoxContext = {
    document: { getElementById: () => firefoxMonth },
    state: { nativeDatePickerTarget: null },
    openMonthCalendar: (target) => { fallbackTarget = target; },
    window: { setTimeout: () => {} }
  };
  vm.runInNewContext(`${pickerHandler}; globalThis.openPicker = openNativeDatePicker;`, firefoxContext);
  firefoxContext.openPicker({
    preventDefault: () => {},
    stopPropagation: () => {},
    currentTarget: { dataset: { datePickerTarget: "month-input" } }
  });
  assert.equal(fallbackTarget, firefoxMonth,
    "Firefox's text fallback for input[type=month] must open the real month calendar");
});

test("entry dates retain the existing year-month-day wheel and storage value", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="entry-date" type="date" required[^>]*aria-controls="date-wheel-dialog"/);
  assert.match(html, /id="entry-date-picker-button" class="date-picker-button"[^>]*data-date-picker-target="entry-date"[^>]*aria-label="日付をカレンダーから選ぶ"/);
  assert.match(html, /id="date-wheel-day"[^>]*aria-label="日"/);
  assert.match(script, /bindDateInput\(el\["entry-date"\]\)/);
  assert.match(script, /el\["entry-date-picker-button"\]\.addEventListener\("click", openNativeDatePicker\)/);
  assert.match(script, /function handleDateClick\(event\)[\s\S]*openDateWheel\(event\.currentTarget, "date"\)/);
  assert.match(script, /function datePartsToString\(\{ year, month, day \}\)/);
  assert.match(script, /entryDate = el\["entry-date"\]\.value/);
});
