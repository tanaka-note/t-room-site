import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("date wheel closes only when its backdrop is selected", async () => {
  const script = await readFile(new URL("../public/billing.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(script, /date-wheel-dialog"\]\.addEventListener\("click", closeDateWheelFromBackdrop\)/);
  assert.match(script, /function closeDateWheelFromBackdrop\(event\) \{\s*if \(event\.target === el\["date-wheel-dialog"\]\) closeDateWheel\(\);\s*\}/);
  assert.match(html, /billing\.js\?v=20260814-calendar-entrypoints/);
});
