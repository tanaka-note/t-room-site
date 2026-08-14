import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("invoice month field reuses the bottom wheel without a day selector", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="month-input" type="month"[^>]*aria-controls="date-wheel-dialog"/);
  assert.match(html, /id="date-wheel-day-group"/);
  assert.match(script, /bindMonthInput\(el\["month-input"\]\)/);
  assert.match(script, /openDateWheel\(event\.currentTarget, "month"\)/);
  assert.match(script, /el\["date-wheel-day-group"\]\.hidden = isMonth/);
  assert.match(script, /el\["date-wheel-window"\]\.classList\.toggle\("is-month-only", isMonth\)/);
  assert.match(script, /state\.dateWheelMode === "month" && state\.dateDraft/);
  assert.match(script, /isMonth \? datePartsToMonth\(state\.dateDraft\) : datePartsToString\(state\.dateDraft\)/);
  assert.match(script, /if \(isMonth\) target\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/);
  assert.match(styles, /\.date-wheel-window\.is-month-only\s*\{\s*grid-template-columns:\s*1\.35fr 1fr;/);
});

test("entry dates retain the existing year-month-day wheel and storage value", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/billing.js", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="entry-date" type="date" required/);
  assert.match(html, /id="date-wheel-day"[^>]*aria-label="日"/);
  assert.match(script, /function datePartsToString\(\{ year, month, day \}\)/);
  assert.match(script, /entryDate = el\["entry-date"\]\.value/);
});
