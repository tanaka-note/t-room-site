import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("date wheel uses guarded background application and history cancellation", async () => {
  const script = await readFile(new URL("../public/billing.js", import.meta.url), "utf8");
  assert.ok(script.includes('dialogs.register("date-wheel-dialog", { backdrop: applyDateWheel'));
  assert.ok(script.includes('return dialogs.close("date-wheel-dialog")'));
});
