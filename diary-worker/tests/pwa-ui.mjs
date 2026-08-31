import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, worker, manifest, serviceWorker, wrangler, pwaAutoUpdate, icon192, icon512, maskable512, appleIcon] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/public/manifest.webmanifest`, "utf8"),
  readFile(`${root}/public/service-worker.js`, "utf8"),
  readFile(`${root}/wrangler.jsonc`, "utf8"),
  readFile(`${root}/../assets/pwa-auto-update.js`, "utf8"),
  readFile(`${root}/public/icons/icon-192-v4.png`),
  readFile(`${root}/public/icons/icon-512-v4.png`),
  readFile(`${root}/public/icons/icon-maskable-512-v4.png`),
  readFile(`${root}/public/icons/apple-touch-icon-v3.png`)
]);

const pngSize = (buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

const parsedManifest = JSON.parse(manifest);
assert.equal(parsedManifest.start_url, "/diary/?source=pwa");
assert.equal(parsedManifest.scope, "/diary/");
assert.equal(parsedManifest.display, "standalone");
assert.ok(parsedManifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(parsedManifest.icons.some((icon) => icon.sizes === "512x512"));
assert.ok(parsedManifest.icons.some((icon) => icon.purpose === "maskable" && icon.src.endsWith("icon-maskable-512-v4.png?v=5")));
assert.deepEqual(pngSize(icon192), { width: 192, height: 192 });
assert.deepEqual(pngSize(icon512), { width: 512, height: 512 });
assert.deepEqual(pngSize(maskable512), { width: 512, height: 512 });
assert.deepEqual(pngSize(appleIcon), { width: 180, height: 180 });
const build = html.match(/name="troom-app-build" content="([^"]+)"/)?.[1];
assert.ok(build, "共通build markerを設定してください。");
assert.ok(html.includes(`rel="manifest" href="/diary/manifest.webmanifest?v=${build}"`));
assert.match(html, /apple-mobile-web-app-capable/);
assert.match(html, /apple-touch-icon/);
assert.ok(html.includes(`name="troom-app-build" content="${build}"`));
assert.match(html, /name="troom-auto-update" content="enabled"/);
assert.match(html, /apple-touch-icon-v3\.png\?v=4/);
assert.ok(html.includes(`pwa-auto-update.js?v=${build}`));
assert.ok(html.includes(`diary.css?v=${build}`));
assert.ok(html.includes(`troom-date-picker.css?v=${build}`));
assert.ok(html.includes(`troom-date-picker.js?v=${build}`));
assert.ok(html.includes(`diary.js?v=${build}`));
assert.match(html, /ホーム画面に追加/);
assert.match(html, /id="login-id"[^>]*type="email"/);
assert.match(html, /id="remember-login"/);
assert.match(html, /Webアプリとして開く/);
assert.doesNotMatch(script, /navigator\.serviceWorker\.register/);
assert.match(pwaAutoUpdate, /navigator\.serviceWorker\.register\(workerUrl/);
assert.match(script, /beforeinstallprompt/);
assert.match(script, /visibilitychange/);
assert.match(script, /troom:before-auto-update/);
assert.match(script, /state\.photoUploading/);
assert.match(pwaAutoUpdate, /const AUTO_UPDATE_META = "troom-auto-update"/);
assert.match(pwaAutoUpdate, /const AUTO_UPDATE_ENABLED = "enabled"/);
assert.match(pwaAutoUpdate, /function canRunAutoUpdate\(\)/);
assert.match(pwaAutoUpdate, /!canRunAutoUpdate\(\) \|\| !currentBuild \|\| !navigator\.onLine/);
assert.ok(serviceWorker.includes(`const CACHE_NAME = "troom-diary-shell-${build}";`));
assert.ok(serviceWorker.includes(`/diary/diary.css?v=${build}`));
assert.ok(serviceWorker.includes(`/diary/troom-date-picker.css?v=${build}`));
assert.ok(serviceWorker.includes(`/diary/troom-date-picker.js?v=${build}`));
assert.ok(serviceWorker.includes(`/diary/diary.js?v=${build}`));
assert.ok(serviceWorker.includes(`/assets/pwa-auto-update.js?v=${build}`));
assert.match(serviceWorker, /icon-maskable-512-v4\.png\?v=5/);
assert.match(script, /new PasswordCredential/);
assert.match(script, /body: \{ loginId, password \}/);
assert.match(worker, /withRollingSession/);
assert.match(worker, /\["\/troom-date-picker\.css", "\/troom-date-picker\.css"\]/);
assert.match(worker, /\["\/troom-date-picker\.js", "\/troom-date-picker\.js"\]/);
assert.match(worker, /PASSWORD_SESSION_TTL_SECONDS/);
assert.match(worker, /!shouldRefreshSession\(session\)/);
assert.match(worker, /DIARY_MAIN_ADMIN_LOGIN_ID/);
assert.match(worker, /DIARY_WIFE_ADMIN_LOGIN_ID/);
assert.doesNotMatch(worker, /DIARY_VIEW_PASSWORD_HASH/);
assert.match(worker, /LOGIN_LIMIT = 5/);
assert.match(wrangler, /"SESSION_TTL_SECONDS": "2592000"/);
assert.match(wrangler, /"PASSKEY_SESSION_TTL_SECONDS": "43200"/);
assert.doesNotMatch(serviceWorker, /\/diary\/api\//);
assert.doesNotMatch(serviceWorker, /\/diary\/photos/);

process.stdout.write("Diary PWA and rolling session contract test passed.\n");
