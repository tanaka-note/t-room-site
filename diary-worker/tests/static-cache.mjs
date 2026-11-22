import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import vm from "node:vm";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return next(specifier, context);
} });
const worker = (await import("../src/index.js")).default;
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
assert.doesNotMatch(html, /investment-section|href="\/diary\/investment/);
const build = html.match(/name="troom-app-build" content="([^"]+)"/)[1];
const origin = "https://fixture.test";
const env = { ASSETS: { fetch: async () => new Response("public fixture", { headers: { "Content-Type": "text/javascript" } }) } };
for (const [path, expected] of [
  [`diary.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary-bootstrap.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary-photo-images.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary-photo-viewer.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary-photo-save.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary.css?v=${build}`, "public, max-age=31536000, immutable"],
  ["diary.js", "public, max-age=3600"], ["diary.js?v=unversioned", "public, max-age=3600"],
  ["", "no-store"], ["favorites/", "no-store"], [`service-worker.js?v=${build}`, "no-cache"],
  [`manifest.webmanifest?v=${build}`, "public, max-age=3600"]
]) {
  const response = await worker.fetch(new Request(`${origin}/diary/${path}`), env, {});
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("Cache-Control"), expected, path);
}
const retirementEnv = {
  DIARY_ENCRYPTION_ENABLED: "true",
  DIARY_ENCRYPTION_ORIGIN: "https://diary.tanaka-note.com",
  get DB() { assert.fail("The retired page must not read diary data"); },
  ASSETS: { fetch: async () => assert.fail("Retired page assets must not be served") }
};
for (const host of ["https://tanaka-note.com", retirementEnv.DIARY_ENCRYPTION_ORIGIN]) {
  for (const path of ["/diary/investment", "/diary/investment/"]) {
    const url = `${host}${path}?legacy=fixture`;
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request(url, { method }), retirementEnv, {});
      assert.equal(response.status, 302, `${method} ${url}`);
      assert.equal(response.headers.get("Location"), "https://tanaka-note.com/household/");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(await response.text(), "");
    }
    const post = await worker.fetch(new Request(url, { method: "POST" }), retirementEnv, {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("Location"), null);
  }
  for (const file of ["investment.html", "investment.js", "investment.css", "investment-encryption.js"]) {
    const response = await worker.fetch(new Request(`${host}/diary/${file}?v=${build}`), retirementEnv, {});
    assert.equal(response.status, 404, file);
  }
}
for (const [file, exported] of [
  ["diary-photo-save.js", /export function createPhotoSaveManager/],
  ["diary-photo-images.js", /export function createPhotoImages/]
]) {
  const module = await worker.fetch(new Request(`${origin}/diary/${file}?v=${build}`), {
    ASSETS: { fetch: async request => {
      assert.equal(new URL(request.url).pathname, `/${file}`, `${file} must route to its own asset`);
      return new Response(await readFile(new URL(`../public/${file}`, import.meta.url), "utf8"), {
        headers: { "Content-Type": "text/javascript" }
      });
    } }
  }, {});
  assert.equal(module.status, 200, file);
  assert.match(await module.text(), exported);
}
const missing = await worker.fetch(new Request(`${origin}/diary/diary.js?v=${build}`), {
  ASSETS: { fetch: async () => new Response("missing", { status: 404 }) }
}, {});
assert.equal(missing.headers.get("Cache-Control"), "public, max-age=3600", "errors are never immutable");

const source = await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8");
const handlers = new Map(), stores = new Map(), fetched = [];
const key = request => new URL(typeof request === "string" ? request : request.url, origin).href;
const caches = { async open(name) {
  if (!stores.has(name)) {
    const values = new Map();
    stores.set(name, { async match(request) { return values.get(key(request))?.clone(); },
      async put(request, response) { values.set(key(request), response.clone()); } });
  }
  return stores.get(name);
}, async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); } };
let offline = false, cacheControl = "public", status = 200, noStoreBodies = false, canceled = 0;
vm.runInNewContext(source, { URL, Response, Set, Promise, caches,
  self: { location: new URL(`${origin}/diary/service-worker.js`), clients: { claim: async () => {} }, skipWaiting() {},
    addEventListener(type, handler) { handlers.set(type, handler); } },
  async fetch(request) {
    fetched.push(key(request));
    if (offline) throw Error("fixture offline");
    return new Response(noStoreBodies ? new ReadableStream({ cancel() { canceled += 1; } }) : "static fixture", { status, headers: { "Cache-Control": cacheControl } });
  }
});
async function lifecycle(type) {
  let promise; handlers.get(type)({ waitUntil(value) { promise = value; } }); await promise;
}
async function fetchAsset(path) {
  let promise; const pending = [];
  handlers.get("fetch")({ request: new Request(`${origin}${path}`), respondWith(value) { promise = value; }, waitUntil(value) { pending.push(value); } });
  const response = promise ? await promise : undefined;
  await Promise.all(pending);
  return response;
}
stores.set("troom-diary-shell-old", {});
await lifecycle("install"); await lifecycle("activate");
assert.equal(stores.has("troom-diary-shell-old"), false);
assert.ok(fetched.some(url => url.includes("diary-bootstrap.js")));
assert.equal(fetched.some(url => new URL(url).pathname.startsWith("/diary/investment")), false);
assert.equal(fetched.some(url => /\/(?:diary|diary-search|diary-photo-processing|diary-photo-upload|diary-photo-images|diary-photo-viewer|diary-rich-text|diary-weather|dialog-navigation|troom-date-picker)\.js\?/.test(url)), false, "install must not undo deferred loading");
const path = `/diary/diary.js?v=${build}`;
let count = fetched.length;
assert.equal((await fetchAsset(path)).status, 200);
assert.equal(fetched.length, count + 1, "cache miss fetches once");
assert.equal((await fetchAsset(path)).status, 200);
assert.equal(fetched.length, count + 1, "warm hit returns without waiting for network");
offline = true;
assert.equal((await fetchAsset(path)).status, 200);
assert.equal((await fetchAsset(`/diary/diary-photo-upload.js?v=${build}`)).status, 503);
offline = false;
for (const file of ["diary-photo-viewer.js", "diary-photo-images.js"]) {
  const modulePath = `/diary/${file}?v=${build}`;
  count = fetched.length;
  assert.equal((await fetchAsset(modulePath)).status, 200, file);
  assert.equal((await fetchAsset(modulePath)).status, 200, file);
  assert.equal(fetched.length, count + 1, `${file} uses the exact build cache after its first request`);
  offline = true;
  assert.equal((await fetchAsset(modulePath)).status, 200, `${file} remains available offline`);
  offline = false;
}
for (const path of ["/diary/", "/diary/api/bootstrap", "/diary/api/session", "/diary/api/photos/id/display",
  "/diary/investment", "/diary/investment/", `/diary/investment.js?v=${build}`, `/diary/manifest.webmanifest?v=${build}`, "/diary/service-worker.js",
  "/diary/diary.js?v=diary-000000000000", `/diary/diary.js?v=${build}&other=1`]) {
  assert.equal(await fetchAsset(path), undefined, `${path}: bypass static caching`);
}
for (const directive of ["no-store", "private"]) {
  cacheControl = directive; count = fetched.length;
  const path = `/diary/diary-photo-processing.js?v=${build}`;
  await fetchAsset(path); await fetchAsset(path);
  assert.equal(fetched.length, count + 2, `${directive} responses must not be cached`);
}
cacheControl = "public"; status = 403; count = fetched.length;
await fetchAsset(`/diary/diary-photo-upload.js?v=${build}`); await fetchAsset(`/diary/diary-photo-upload.js?v=${build}`);
assert.equal(fetched.length, count + 2, "errors must not be cached");
noStoreBodies = true; cacheControl = "no-store"; status = 200; count = fetched.length;
await lifecycle("install");
assert.equal(canceled, fetched.length - count, "uncacheable install bodies must be canceled to release network connections");
console.log("Diary static caching: exact public build URLs, deferred install, cold/warm/offline, no-store and retired routes passed.");
