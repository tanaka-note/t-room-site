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
const build = html.match(/name="troom-app-build" content="([^"]+)"/)[1];
const origin = "https://fixture.test";
const env = { ASSETS: { fetch: async () => new Response("public fixture", { headers: { "Content-Type": "text/javascript" } }) } };
for (const [path, expected] of [
  [`diary.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary-bootstrap.js?v=${build}`, "public, max-age=31536000, immutable"],
  [`diary.css?v=${build}`, "public, max-age=31536000, immutable"],
  ["diary.js", "public, max-age=3600"], ["diary.js?v=unversioned", "public, max-age=3600"],
  ["", "no-store"], ["favorites/", "no-store"], [`service-worker.js?v=${build}`, "no-cache"],
  [`manifest.webmanifest?v=${build}`, "public, max-age=3600"]
]) {
  const response = await worker.fetch(new Request(`${origin}/diary/${path}`), env, {});
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get("Cache-Control"), expected, path);
}
for (const path of ["investment.js", "investment.css"]) {
  assert.equal((await worker.fetch(new Request(`${origin}/diary/${path}?v=${build}`), env, {})).status, 404, "protected assets still require authorization");
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
assert.equal(fetched.some(url => /\/(?:diary|diary-search|diary-photo-processing|diary-photo-upload|diary-rich-text|diary-weather|dialog-navigation|troom-date-picker)\.js\?/.test(url)), false, "install must not undo deferred loading");
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
for (const path of ["/diary/", "/diary/api/bootstrap", "/diary/api/session", "/diary/api/photos/id/display",
  `/diary/investment.js?v=${build}`, `/diary/manifest.webmanifest?v=${build}`, "/diary/service-worker.js",
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
console.log("Diary static caching: exact public build URLs, deferred install, cold/warm/offline, no-store and protected exclusions passed.");
