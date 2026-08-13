import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, worker, server, offline, manifestSource, css] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/media-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/offline.html", import.meta.url), "utf8"),
  readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8")
]);
const manifest = JSON.parse(manifestSource);

for (const [source, runtime] of [
  ["cloud.js", "cloud-runtime-20260813-5.js"],
  ["cloud.css", "cloud-runtime-20260813-3.css"],
  ["offline-store.js", "offline-store-20260811-2.js"],
  ["display-cache.js", "display-cache-20260813-1.js"],
  ["media-client.js", "media-client-20260811-12.js"],
  ["media-worker.js", "media-worker-20260811-19.js"],
  ["manifest.webmanifest", "manifest-20260811-1.webmanifest"],
  ["share.js", "share-runtime-20260813-1.js"],
  ["share.css", "share-runtime-20260813-1.css"]
]) {
  assert.deepEqual(
    await readFile(new URL(`../public/${runtime}`, import.meta.url)),
    await readFile(new URL(`../public/${source}`, import.meta.url)),
    `${runtime}を最新ソースと一致させてください。`
  );
  assert.ok(server.includes(`"/${runtime}"`), `${runtime}をCloudflareの実体ファイルとして配信してください。`);
}

assert.equal(manifest.name, "T-Cloud Storage");
assert.equal(manifest.start_url, "/cloud/?source=pwa");
assert.equal(manifest.scope, "/cloud/");
assert.equal(manifest.display, "standalone");
assert.equal(manifest.orientation, "portrait-primary");
assert.equal(manifest.theme_color, "#071426");
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
assert.ok(manifest.icons.every((icon) => icon.src.includes("-v3.png?rev=20260811-3")), "既存PWAへ新しいアイコンURLを通知してください。");

assert.match(html, /rel="manifest" href="\/cloud\/manifest\.webmanifest"/, "既存PWAの更新経路を維持するためmanifestのURLを変更しないでください。");
assert.match(html, /apple-touch-icon-v3\.png\?rev=20260811-3/);
assert.match(html, /name="theme-color" content="#071426"/);
assert.match(html, /name="tcloud-build" content="20260813-5"/);
assert.match(html, /name="troom-app-build" content="20260813-5"/);
assert.match(html, /pwa-auto-update\.js\?v=20260812-1/);
assert.match(html, /id="install-app-button-top"/);
assert.match(html, /id="update-app-button-top"/);
assert.doesNotMatch(html, /id="install-app-button"/);
assert.match(html, /id="install-app-button-top"[^>]*aria-label="ホームへ追加"[^>]*title="ホームへ追加"/);
assert.match(html, /id="update-app-button-top"[^>]*aria-label="アプリを更新"[^>]*title="アプリを更新"/);
assert.match(css, /#update-app-button-top\[hidden\][^{]*\{ display: none; \}/);
assert.match(css, /\.file-card \.file-select-button, \.folder-card \.folder-select-button \{[^}]*width: 30px;[^}]*min-width: 30px;[^}]*max-width: 30px;[^}]*height: 30px;/);
assert.doesNotMatch(css, /\.list-mode \.file-card button \{/);
assert.match(css, /\.list-mode \.file-card > button:not\(\.file-select-button\) \{ min-height: 76px;/);
assert.match(css, /\.content-grid\.list-mode \.file-card > button:not\(\.file-select-button\) \{ grid-template-columns: 76px minmax\(0,1fr\); \}/);
assert.doesNotMatch(css, /\.folder-settings-button/);
assert.match(html, /id="install-app-button-top"[\s\S]*?<svg[\s\S]*?<path/);
assert.match(html, /id="install-guide-dialog"/);
assert.match(client, /beforeinstallprompt/);
assert.match(client, /async function installApp\(\)/);
assert.match(client, /\$\("#install-app-button-top"\)\.hidden = standalone/);
assert.match(client, /\$\("#update-app-button-top"\)\.hidden = !standalone/);
assert.match(client, /async function updateInstalledApp\(\)/);
assert.match(client, /state\.uploading \|\| state\.activeFolderUploadOperationId \|\| state\.downloadActive/);
assert.match(client, /const APP_BUILD_ID = "20260813-5"/);
assert.match(client, /mapWithConcurrency\(records, 8/);
assert.match(client, /troom:before-auto-update/);
assert.match(client, /app-version\?app-update=\$\{Date\.now\(\)\}[\s\S]*?cache: "no-store"/);
assert.match(client, /registration\.addEventListener\("updatefound"/);
assert.match(client, /navigator\.serviceWorker\.addEventListener\("controllerchange"/);
assert.match(client, /worker\.state === "activated"/);
assert.match(client, /publishedBuild === APP_BUILD_ID/);
assert.match(client, /location\.replace\(target\.href\)/);
assert.doesNotMatch(client, /setTimeout\(\(\) => location\.reload\(\), 450\)/);
assert.match(client, /Safariの共有ボタン/);
assert.match(client, /ホーム画面に追加/);
assert.match(client, /async function registerPwaWorker\(\)/);
assert.match(client, /await registration\.update\(\)/);
assert.match(client, /screen\.orientation\.lock\("portrait-primary"\)/);
assert.match(client, /prepareInstalledVideoFullscreen[\s\S]*?screen\.orientation\.lock\("any"\)/);
assert.match(worker, /const APP_SHELL_CACHE/);
assert.match(worker, /tcloud-shell-20260811-19/);
assert.match(worker, /data\.type === "SKIP_WAITING"/);
assert.match(worker, /\/cloud\/manifest\.webmanifest/);
assert.match(worker, /icon-192-v3\.png\?rev=20260811-3/);
assert.match(worker, /event\.request\.mode === "navigate"/);
assert.doesNotMatch(worker, /caches\.put/);
assert.doesNotMatch(worker.match(/const APP_SHELL_ASSETS = \[[\s\S]*?\];/)?.[0] || "", /\/cloud\/api/);
for (const path of ["/manifest.webmanifest", "/offline", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]) {
  assert.ok(server.includes(`["${path}",`), `${path} is not publicly routed`);
}
for (const path of ["/manifest-v2.webmanifest", "/icons/icon-192-v2.png", "/icons/icon-512-v2.png", "/icons/icon-maskable-512-v2.png", "/icons/apple-touch-icon-v2.png"]) {
  assert.ok(server.includes(`["${path}",`), `${path} is not publicly routed`);
}
for (const path of ["/icons/icon-192-v3.png", "/icons/icon-512-v3.png", "/icons/icon-maskable-512-v3.png", "/icons/apple-touch-icon-v3.png"]) {
  assert.ok(server.includes(`["${path}",`), `${path} is not publicly routed`);
}
assert.match(server, /application\/manifest\+json/);
assert.match(server, /isPwaMetadataAsset[\s\S]*?Cache-Control/, "manifestとアイコンは再検証できるキャッシュ設定にしてください。");
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
for (const [filename, expected] of [["icon-192-v3.png", 192], ["icon-512-v3.png", 512], ["icon-maskable-512-v3.png", 512], ["apple-touch-icon-v3.png", 180]]) {
  const png = await readFile(new URL(`../public/icons/${filename}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), expected);
  assert.equal(png.readUInt32BE(20), expected);
}

console.log("installable privacy-preserving PWA shell: ok");
