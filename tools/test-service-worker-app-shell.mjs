import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  collectEntrypointShellAssets,
  expectedBuild,
  loadWebAppRegistry,
  syncServiceWorkerText,
  workspace
} from "./web-app-registry.mjs";

const registry = await loadWebAppRegistry();
const workerApps = registry.apps.filter((app) => app.serviceWorker);

for (const app of workerApps) {
  const build = await expectedBuild(app, registry.contract);
  const source = await readFile(resolve(workspace, app.serviceWorker), "utf8");
  const shellAssets = app.precacheMode === "html"
    ? await collectEntrypointShellAssets(app, registry.contract, build)
    : [];
  assert.equal(syncServiceWorkerText(source, app, build, shellAssets), source, `${app.id}: 同じbuildの再同期で差分が発生します`);
  for (const copy of app.serviceWorkerCopies || []) {
    assert.equal(await readFile(resolve(workspace, copy), "utf8"), source, `${app.id}: 公開用Service Workerコピーが同期されていません`);
  }
  if (app.precacheMode === "html") {
    for (const asset of shellAssets) assert(source.includes(JSON.stringify(asset)), `${app.id}: ${asset} がprecacheにありません`);
  }
}

const calculator = workerApps.find((app) => app.id === "calculator");
const calculatorBuild = await expectedBuild(calculator, registry.contract);
const calculatorSource = await readFile(resolve(workspace, calculator.serviceWorker), "utf8");
const calculatorAssets = await collectEntrypointShellAssets(calculator, registry.contract, calculatorBuild);
const previousBuild = "calculator-000000000000";
const previousSource = calculatorSource.replaceAll(calculatorBuild, previousBuild);
const updatedSource = syncServiceWorkerText(previousSource, calculator, calculatorBuild, calculatorAssets);
assert.notEqual(updatedSource, previousSource, "build更新時にService Workerが更新されません");
assert.equal(syncServiceWorkerText(updatedSource, calculator, calculatorBuild, calculatorAssets), updatedSource, "更新後の再同期が安定しません");
for (const asset of calculatorAssets) assert(updatedSource.includes(JSON.stringify(asset)), `build更新後のprecacheに${asset}がありません`);
const handlers = new Map();
const origin = "https://tanaka-note.com";
const stores = new Map();
let online = true;

function keyOf(request) {
  const value = typeof request === "string" ? request : request.url;
  return new URL(value, `${origin}/apps/calculator/`).href;
}

class TestCache {
  constructor() { this.entries = new Map(); }
  async addAll(urls) {
    for (const url of urls) {
      const response = await testFetch(url);
      if (!response.ok) throw new Error(`precache failed: ${url}`);
      this.entries.set(keyOf(url), response.clone());
    }
  }
  async put(request, response) { this.entries.set(keyOf(request), response.clone()); }
  async match(request) { return this.entries.get(keyOf(request))?.clone(); }
}

const caches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new TestCache());
    return stores.get(name);
  },
  async keys() { return [...stores.keys()]; },
  async delete(name) { return stores.delete(name); },
  async match(request) {
    for (const cache of stores.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
  }
};

async function testFetch(request) {
  if (!online) throw new Error("offline");
  const url = keyOf(request);
  return new Response(`network:${url}`, { status: 200 });
}

const self = {
  location: new URL(`${origin}/apps/calculator/sw.js`),
  clients: { async claim() {} },
  async skipWaiting() {},
  addEventListener(type, handler) { handlers.set(type, handler); }
};
vm.runInNewContext(calculatorSource, { self, caches, fetch: testFetch, URL, Response, Promise, Set });

async function dispatchLifecycle(type) {
  let pending;
  handlers.get(type)({ waitUntil(value) { pending = Promise.resolve(value); } });
  await pending;
}

stores.set("t-room-calculator-old-build", new TestCache());
await dispatchLifecycle("install");
await dispatchLifecycle("activate");
assert(!stores.has("t-room-calculator-old-build"), "activate後も旧build cacheが残っています");
assert(stores.has(`${calculator.cachePrefix}${calculatorBuild}`), "現在build cacheが作成されていません");

online = false;
for (const asset of calculatorAssets.filter((value) => /\.(?:css|js)(?:\?|$)/.test(value))) {
  let responsePromise;
  handlers.get("fetch")({
    request: { method: "GET", mode: "cors", url: new URL(asset, origin).href },
    respondWith(value) { responsePromise = Promise.resolve(value); }
  });
  assert(responsePromise, `${asset}: オフラインfetchがService Workerに処理されません`);
  const response = await responsePromise;
  assert.equal(response.status, 200, `${asset}: 最新app shellをcacheから取得できません`);
}

process.stdout.write(`Service Worker app shell: ${workerApps.length}アプリの同期安定性と最新版オフライン取得を確認しました。\n`);
