import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const clients = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

for (const source of clients) {
  assert.match(source, /function absoluteSeekTime\(pointerX, trackLeft, trackWidth, duration\)/);
  assert.match(source, /seekPointerUsesAbsolutePosition = event\.pointerType === "mouse"/);
  assert.match(source, /seekPointerUsesAbsolutePosition[\s\S]*?absoluteSeekTime\(event\.clientX, bounds\.left, bounds\.width, video\.duration\)[\s\S]*?: seekPointerStartSeconds/);
  assert.match(source, /seekPointerUsesAbsolutePosition[\s\S]*?absoluteSeekTime\(event\.clientX, bounds\.left, bounds\.width, video\.duration\)[\s\S]*?: relativeSeekTime\(seekPointerStartSeconds, seekPointerStartX, event\.clientX, bounds\.width, video\.duration\)/);
  const functionSource = source.match(/function absoluteSeekTime\([\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const context = {};
  vm.runInNewContext(`${functionSource}; globalThis.seekAt = absoluteSeekTime;`, context);
  assert.equal(context.seekAt(150, 100, 200, 600), 150);
  assert.equal(context.seekAt(300, 100, 200, 600), 600);
  assert.equal(context.seekAt(50, 100, 200, 600), 0);
}

console.log("mouse seek uses the clicked position while touch retains relative scrubbing: ok");
