import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [html, script, styles, worker, registry, manifest] = await Promise.all([
  read("../public/index.html"),
  read("../public/billing.js"),
  read("../public/billing.css"),
  read("../src/index.js"),
  read("../../web-apps.json").then(JSON.parse),
  read("../public/manifest.webmanifest").then(JSON.parse)
]);

test("billing declares a standalone app at its existing URL using the official icons", async () => {
  const app = registry.apps.find((item) => item.id === "billing");
  assert.equal(app.manifest, "billing-worker/public/manifest.webmanifest");
  assert.equal(app.serviceWorker, null);
  assert.equal(app.buildMode, "content-hash");
  assert.equal(app.deployTarget, "t-room-billing");
  assert.equal(app.deployCwd, "billing-worker");
  const manifestLink = html.match(/<link\b[^>]*rel="manifest"[^>]*href="([^"]+)"/);
  assert.ok(manifestLink);
  assert.equal(new URL(manifestLink[1], app.publicUrls[0]).pathname, "/billing/manifest.webmanifest");
  for (const key of ["id", "start_url", "scope"]) assert.equal(manifest[key], "/billing/");
  assert.equal(manifest.name, "請求書管理システム");
  assert.equal(manifest.short_name, "請求書管理");
  assert.equal(manifest.lang, "ja");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, undefined);
  assert.notEqual(manifest.prefer_related_applications, true);
  assert.equal(manifest.background_color, styles.match(/--paper:\s*(#[a-f0-9]+)/i)[1]);
  assert.equal(manifest.theme_color, styles.match(/--accent:\s*(#[a-f0-9]+)/i)[1]);
  assert.ok(html.includes(`<meta name="theme-color" content="${manifest.theme_color}">`));
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item) => item.sizes === `${size}x${size}`);
    assert.ok(icon);
    assert.equal(icon.src, `/assets/site-icon-${size}.png`);
    assert.equal(icon.type, "image/png");
    assert.equal(icon.purpose || "any", "any");
    const bytes = await readFile(new URL(`../..${icon.src}`, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
});

test("billing serves the manifest for plain and versioned URLs without widening the asset allowlist", async () => {
  const source = worker.match(/async function serveAsset\([^]*?\n\}/)?.[0];
  assert.ok(source, "the asset handler must be available for the route test");
  const serveAsset = vm.runInNewContext(`(${source})`, { Request, Response, Headers, URL });
  const calls = [];
  const env = { ASSETS: { async fetch(request) {
    calls.push(new URL(request.url).pathname);
    return new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/manifest+json" }
    });
  } } };
  for (const suffix of ["", "?v=billing-test", "?v=billing-test&app-version-check=1"]) {
    const url = new URL(`https://tanaka-note.com/billing/manifest.webmanifest${suffix}`);
    const response = await serveAsset(new Request(url), env, url, url.pathname.slice("/billing".length));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), manifest);
    assert.equal(response.headers.get("Content-Type"), "application/manifest+json");
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  assert.deepEqual(calls, Array(3).fill("/manifest.webmanifest"));
  for (const path of ["/sw.js", "/service-worker.js", "/unlisted.json"]) {
    const url = new URL(`https://tanaka-note.com/billing${path}`);
    assert.equal((await serveAsset(new Request(url), env, url, path)).status, 404);
  }
  assert.equal(calls.length, 3);
});

test("billing keeps shared automatic updates and provides no custom installation UI or prompt", () => {
  assert.match(html, /name="troom-app-build"/);
  assert.match(html, /name="troom-auto-update" content="enabled"/);
  assert.match(html, /src="\/assets\/pwa-auto-update\.js\?v=/);
  assert.doesNotMatch(html, /troom-service-worker/);
  for (const source of [html, script]) {
    assert.doesNotMatch(source, /beforeinstallprompt|appinstalled|deferredPrompt|installPrompt|\.prompt\s*\(/i);
    assert.doesNotMatch(source, /アプリをインストール|ホーム画面に追加|インストール/);
    assert.doesNotMatch(source, /(?:id|class|data-[\w-]+)=["'][^"']*install/i);
    assert.doesNotMatch(source, /serviceWorker\s*\.\s*register\s*\(/);
  }
});
