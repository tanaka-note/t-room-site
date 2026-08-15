import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(import.meta.dirname, "..");
const sourceScript = await readFile(resolve(root, "tools/shared/troom-date-picker.js"), "utf8");
const sourceStyle = await readFile(resolve(root, "tools/shared/troom-date-picker.css"), "utf8");

for (const directory of ["diary-worker/public", "billing-worker/public"]) {
  assert.equal(await readFile(resolve(root, directory, "troom-date-picker.js"), "utf8"), sourceScript,
    `${directory} must use the canonical shared calendar script`);
  assert.equal(await readFile(resolve(root, directory, "troom-date-picker.css"), "utf8"), sourceStyle,
    `${directory} must use the canonical shared calendar styles`);
}

let readyHandler = null;
const context = {
  window: {},
  document: {
    readyState: "loading",
    addEventListener: (name, handler) => { if (name === "DOMContentLoaded") readyHandler = handler; }
  },
  Intl,
  Date,
  Event,
  setTimeout
};
vm.runInNewContext(sourceScript, context);
assert.equal(typeof readyHandler, "function");
const api = context.window.TRoomDatePicker;
assert.ok(api);
assert.deepEqual(JSON.parse(JSON.stringify(api.parseValue("2028-02-29", "date"))), { year: 2028, month: 2, day: 29 });
assert.equal(api.parseValue("2027-02-29", "date"), null);
assert.deepEqual(JSON.parse(JSON.stringify(api.parseValue("2026-08", "month"))), { year: 2026, month: 8, day: 1 });
assert.equal(api.parseValue("2026-13", "month"), null);
assert.equal(api.formatValue({ year: 2026, month: 8, day: 5 }, "date"), "2026-08-05");
assert.equal(api.formatValue({ year: 2026, month: 8, day: 5 }, "month"), "2026-08");
assert.deepEqual(JSON.parse(JSON.stringify(api.calendarCells(2026, 8))).slice(0, 8), [null, null, null, null, null, null, 1, 2]);
assert.doesNotMatch(sourceScript, /showPicker|calendar-picker-indicator|userAgent|Firefox|Chrome/);

process.stdout.write("Shared T-ROOM date picker parity and date arithmetic tests passed.\n");
