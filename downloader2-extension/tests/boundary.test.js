import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Production controller is top-frame Downloader 2 only", () => {
  const manifest = JSON.parse(source("manifest.json"));
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://tanaka-note.com/downloader2/*"]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.deepEqual(manifest.content_scripts[0].js, ["profile.js", "content-script.js"]);
  assert.match(source("service-worker.js"), /CONTROLLER_ORIGINS\.has\(url\.origin\)[\s\S]*url\.pathname\.startsWith\("\/downloader2\/"\)[\s\S]*sender\.frameId === 0/);
});

test("capture state is tab-scoped and discarded on stop", () => {
  const worker = source("service-worker.js");
  assert.match(worker, /function isCaptureTab\(tabId\) \{ return capture\?\.captureTabId != null && tabId === capture\.captureTabId; \}/);
  assert.match(worker, /async function stopCapture\(\)[\s\S]*capture = null;[\s\S]*requests\.clear\(\);/);
  assert.match(worker, /if \(payload\?\.deep\)[\s\S]*chrome\.permissions\.request\(\{ permissions: \["debugger"\] \}\)/);
  assert.match(worker, /chrome\.debugger\.detach/);
});

test("secrets remain transient and are not logged or stored by the extension", () => {
  const combined = `${source("service-worker.js")}\n${source("capture/request-context.js")}`;
  assert.doesNotMatch(combined, /chrome\.storage|localStorage|sessionStorage|console\./);
  assert.match(combined, /"authorization", "cookie"/);
});
