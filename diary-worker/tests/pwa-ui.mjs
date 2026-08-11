import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, worker, manifest, serviceWorker, wrangler] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/public/manifest.webmanifest`, "utf8"),
  readFile(`${root}/public/service-worker.js`, "utf8"),
  readFile(`${root}/wrangler.jsonc`, "utf8")
]);

const parsedManifest = JSON.parse(manifest);
assert.equal(parsedManifest.start_url, "/diary/?source=pwa");
assert.equal(parsedManifest.scope, "/diary/");
assert.equal(parsedManifest.display, "standalone");
assert.ok(parsedManifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(parsedManifest.icons.some((icon) => icon.sizes === "512x512"));
assert.match(html, /rel="manifest" href="\/diary\/manifest\.webmanifest"/);
assert.match(html, /apple-mobile-web-app-capable/);
assert.match(html, /apple-touch-icon/);
assert.match(html, /ホーム画面に追加/);
assert.match(html, /Webアプリとして開く/);
assert.match(script, /navigator\.serviceWorker\.register/);
assert.match(script, /beforeinstallprompt/);
assert.match(script, /visibilitychange/);
assert.match(worker, /withRollingSession/);
assert.match(worker, /SESSION_TTL_SECONDS = 365 \* 24 \* 60 \* 60/);
assert.match(wrangler, /"SESSION_TTL_SECONDS": "31536000"/);
assert.doesNotMatch(serviceWorker, /\/diary\/api\//);
assert.doesNotMatch(serviceWorker, /\/diary\/photos/);

process.stdout.write("Diary PWA and rolling session contract test passed.\n");
