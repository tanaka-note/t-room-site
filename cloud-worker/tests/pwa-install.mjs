import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, worker, server, offline, manifestSource] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/media-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/offline.html", import.meta.url), "utf8"),
  readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")
]);
const manifest = JSON.parse(manifestSource);

assert.equal(manifest.name, "T-Cloud Storage");
assert.equal(manifest.start_url, "/cloud/?source=pwa");
assert.equal(manifest.scope, "/cloud/");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.orientation, "any");
assert.equal(manifest.theme_color, "#071426");
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
assert.ok(manifest.icons.every((icon) => icon.src.includes("-v2.png?rev=71e8df8")), "既存PWAへ新しいアイコンURLを通知してください。");

assert.match(html, /rel="manifest" href="\/cloud\/manifest-v2\.webmanifest\?rev=71e8df8"/);
assert.match(html, /apple-touch-icon-v2\.png\?rev=71e8df8/);
assert.match(html, /name="theme-color" content="#071426"/);
assert.match(html, /id="install-app-button-top"/);
assert.doesNotMatch(html, /id="install-app-button"/);
assert.match(html, /id="install-app-button-top"[^>]*aria-label="ホームへ追加"[^>]*title="ホームへ追加"/);
assert.match(html, /id="install-app-button-top"[\s\S]*?<svg[\s\S]*?<path/);
assert.match(html, /id="install-guide-dialog"/);
assert.match(client, /beforeinstallprompt/);
assert.match(client, /async function installApp\(\)/);
assert.match(client, /const available = !standalone/);
assert.match(client, /\$\("#install-app-button-top"\)\.hidden = !available/);
assert.match(client, /Safariの共有ボタン/);
assert.match(client, /ホーム画面に追加/);
assert.match(client, /async function registerPwaWorker\(\)/);
assert.match(client, /preserveAppOrientation/);
assert.match(client, /screen\.orientation\.lock\("portrait-primary"\)/);
assert.match(client, /screen\.orientation\?\.unlock/);
assert.doesNotMatch(client, /screen\.orientation\.lock\("landscape"\)/);
assert.match(worker, /const APP_SHELL_CACHE/);
assert.match(worker, /tcloud-shell-20260810-5/);
assert.match(worker, /icon-192-v2\.png\?rev=71e8df8/);
assert.match(worker, /event\.request\.mode === "navigate"/);
assert.doesNotMatch(worker, /caches\.put/);
assert.doesNotMatch(worker.match(/const APP_SHELL_ASSETS = \[[\s\S]*?\];/)?.[0] || "", /\/cloud\/api/);
for (const path of ["/manifest.webmanifest", "/offline", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]) {
  assert.ok(server.includes(`["${path}", "${path}"]`), `${path} is not publicly routed`);
}
for (const path of ["/manifest-v2.webmanifest", "/icons/icon-192-v2.png", "/icons/icon-512-v2.png", "/icons/icon-maskable-512-v2.png", "/icons/apple-touch-icon-v2.png"]) {
  assert.ok(server.includes(`["${path}",`), `${path} is not publicly routed`);
}
assert.match(server, /application\/manifest\+json/);
assert.match(offline, /ネットワークに接続できません/);

for (const [filename, expected] of [["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512], ["apple-touch-icon.png", 180]]) {
  const png = await readFile(new URL(`../public/icons/${filename}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), expected);
  assert.equal(png.readUInt32BE(20), expected);
}
for (const [filename, expected] of [["icon-192-v2.png", 192], ["icon-512-v2.png", 512], ["icon-maskable-512-v2.png", 512], ["apple-touch-icon-v2.png", 180]]) {
  const png = await readFile(new URL(`../public/icons/${filename}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), expected);
  assert.equal(png.readUInt32BE(20), expected);
}

console.log("installable privacy-preserving PWA shell: ok");
