import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const apps = [
  ["cloud-worker/public/index.html", "/cloud/media-worker.js"],
  ["diary-worker/public/index.html", "/diary/service-worker.js"],
  ["asset-report-k7m4q9x2/index.html", "./service-worker.js"],
  ["apps/calculator/index.html", "./sw.js"],
  ["apps/omikuji/index.html", "./sw.js"],
  ["apps/kokoro-tenbin/index.html", "./sw.js"],
  ["apps/ima-camera/index.html", "./sw.js"],
  ["apps/motivation-switch/index.html", "./sw.js"]
];

for (const [path, workerUrl] of apps) {
  const html = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(html, /name="troom-app-build" content="[^"]+"/, `${path}: build metadata`);
  assert.ok(html.includes(`name="troom-service-worker" content="${workerUrl}"`), `${path}: worker metadata`);
  assert.match(html, /\/assets\/pwa-auto-update\.js\?v=20260812-1/, `${path}: updater script`);
}

const updater = await readFile(new URL("../assets/pwa-auto-update.js", import.meta.url), "utf8");
assert.match(updater, /display-mode: standalone/);
assert.match(updater, /cache: "no-store"/);
assert.match(updater, /visibilitychange/);
assert.match(updater, /controllerchange/);
assert.match(updater, /troom:before-auto-update/);
assert.match(updater, /input\[type="file"\]/);
assert.match(updater, /input\[type="password"\]/);
assert.match(updater, /updateViaCache: "none"/);
assert.match(updater, /location\.replace/);

process.stdout.write("automatic PWA update contract: ok\n");
