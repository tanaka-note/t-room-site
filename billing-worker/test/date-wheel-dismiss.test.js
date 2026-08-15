import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("date wheel applies only when its backdrop is selected", async () => {
  const script = await readFile(new URL("../public/billing.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(script, /date-wheel-dialog"\]\.addEventListener\("click", applyDateWheelFromBackdrop\)/);
  assert.match(script, /function applyDateWheelFromBackdrop\(event\) \{\s*if \(event\.target === el\["date-wheel-dialog"\]\) applyDateWheel\(\);\s*\}/);
  assert.match(html, /billing\.js\?v=20260815-custom-calendar-1/);

  const source = script.match(/function applyDateWheelFromBackdrop\(event\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.ok(source);
  const dialog = {};
  let applyCount = 0;
  const context = { el: { "date-wheel-dialog": dialog }, applyDateWheel: () => { applyCount += 1; } };
  vm.runInNewContext(`${source}; globalThis.handleBackdrop = applyDateWheelFromBackdrop;`, context);
  context.handleBackdrop({ target: {} });
  assert.equal(applyCount, 0, "clicks inside the wheel must not apply or close it");
  context.handleBackdrop({ target: dialog });
  assert.equal(applyCount, 1, "one backdrop click must run the shared apply action exactly once");
});
