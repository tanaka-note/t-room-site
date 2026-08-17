import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { workspace } from "./web-app-registry.mjs";

const updaterSource = await readFile(resolve(workspace, "assets/pwa-auto-update.js"), "utf8");

class TestEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.cancelable = Boolean(options.cancelable);
    this.detail = options.detail;
    this.defaultPrevented = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class TestEventTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return !event.defaultPrevented;
  }
}

function createRuntime({
  enabled = true,
  standalone = false,
  workerUrl = "",
  online = true,
  currentBuild = "old-build",
  publishedBuild = "new-build",
  blockReload = false,
  previousAttempt = null
} = {}) {
  const document = new TestEventTarget();
  const window = new TestEventTarget();
  const serviceWorker = new TestEventTarget();
  const timers = [];
  const storage = new Map();
  const replacements = [];
  const registrations = [];
  let fetchCount = 0;
  let blocked = blockReload;
  if (previousAttempt) storage.set("troom-pwa-update-attempt:/app/", JSON.stringify(previousAttempt));

  const metas = new Map([
    ["troom-app-build", currentBuild],
    ["troom-auto-update", enabled ? "enabled" : ""],
    ["troom-service-worker", workerUrl]
  ]);
  document.hidden = false;
  document.activeElement = null;
  document.querySelector = (selector) => {
    const meta = selector.match(/^meta\[name="([^"]+)"\]$/)?.[1];
    if (meta) return metas.get(meta) ? { content: metas.get(meta) } : null;
    if (selector.includes("data-troom-update-block") || selector.includes("data-troom-dirty")) {
      return blocked ? {} : null;
    }
    return null;
  };
  document.querySelectorAll = () => [];
  document.addEventListener("troom:before-auto-update", (event) => {
    if (blocked) event.preventDefault();
  });

  const navigator = {
    onLine: online,
    standalone,
    serviceWorker: Object.assign(serviceWorker, {
      controller: workerUrl ? {} : null,
      async register(url, options) {
        const registration = { url, options, updates: 0, async update() { this.updates += 1; } };
        registrations.push(registration);
        return registration;
      }
    })
  };
  const location = {
    href: "https://tanaka-note.com/app/",
    pathname: "/app/",
    replace(url) { replacements.push(String(url)); },
    reload() { replacements.push("reload"); }
  };
  window.navigator = navigator;
  window.location = location;
  window.matchMedia = () => ({ matches: standalone });
  window.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  window.setInterval = () => 1;
  window.clearTimeout = () => {};

  const context = vm.createContext({
    window,
    document,
    navigator,
    location,
    URL,
    URLSearchParams,
    CustomEvent: TestEvent,
    Event: TestEvent,
    DOMParser: class {
      parseFromString(html) {
        return { querySelector: () => ({ content: html.match(/content="([^"]+)"/)?.[1] || "" }) };
      }
    },
    fetch: async () => {
      fetchCount += 1;
      if (!navigator.onLine) throw new Error("offline");
      return { ok: true, status: 200, text: async () => `<meta name="troom-app-build" content="${publishedBuild}">` };
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    console: { warn() {} },
    Date
  });
  vm.runInContext(updaterSource, context);

  return {
    window,
    document,
    navigator,
    timers,
    replacements,
    registrations,
    get fetchCount() { return fetchCount; },
    setBlocked(value) { blocked = value; },
    async runTimer(index = 0) {
      const callback = timers.splice(index, 1)[0];
      if (callback) callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

{
  const app = createRuntime();
  await app.runTimer();
  assert.equal(app.fetchCount, 1, "通常ブラウザでbuildを確認する");
  assert.match(app.replacements[0], /app-update=new-build/, "Service Workerなしでも最新版へ移行する");
}

{
  const pwa = createRuntime({ enabled: false, standalone: true, workerUrl: "/app/sw.js" });
  await pwa.runTimer();
  assert.equal(pwa.registrations.length, 1, "既存PWAも移行期間中は更新する");
  assert.equal(pwa.registrations[0].options.updateViaCache, "none");
  assert.equal(pwa.registrations[0].updates, 1);
  assert.match(pwa.replacements[0], /app-update=new-build/);
}

{
  const twa = createRuntime({ enabled: true, standalone: true, workerUrl: "/app/sw.js" });
  await twa.runTimer();
  assert.match(twa.replacements[0], /app-update=new-build/, "TWA相当でもWeb側が更新される");
}

{
  const sameBuild = createRuntime({
    workerUrl: "/app/sw.js?v=current-build",
    currentBuild: "current-build",
    publishedBuild: "current-build"
  });
  sameBuild.window.dispatchEvent(new TestEvent("pageshow"));
  sameBuild.window.dispatchEvent(new TestEvent("focus"));
  await sameBuild.runTimer();
  assert.equal(sameBuild.fetchCount, 1, "cold startの更新確認を1回にまとめる");
  assert.equal(sameBuild.registrations.length, 1, "同一scopeのService Worker登録を1回にまとめる");
  assert.equal(sameBuild.registrations[0].url, "/app/sw.js?v=current-build", "契約済みbuild URLだけを登録する");
  assert.equal(sameBuild.registrations[0].updates, 1, "同一buildの更新確認を重複実行しない");
  assert.deepEqual(sameBuild.replacements, [], "同一buildではreloadしない");
  sameBuild.navigator.serviceWorker.dispatchEvent(new TestEvent("controllerchange"));
  assert.deepEqual(sameBuild.replacements, [], "controllerchangeだけではreloadしない");
}

{
  const oneUpdate = createRuntime({ workerUrl: "/app/sw.js?v=old-build" });
  await oneUpdate.runTimer();
  oneUpdate.navigator.serviceWorker.dispatchEvent(new TestEvent("controllerchange"));
  oneUpdate.navigator.serviceWorker.dispatchEvent(new TestEvent("controllerchange"));
  assert.equal(oneUpdate.replacements.length, 1, "新buildへの移行も1回だけ行う");
  assert.match(oneUpdate.replacements[0], /app-update=new-build/);
}

{
  const editing = createRuntime({ blockReload: true });
  await editing.runTimer();
  assert.equal(editing.replacements.length, 0, "未保存中はreloadしない");
  editing.setBlocked(false);
  editing.document.dispatchEvent(new TestEvent("troom:auto-update-ready"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(editing.replacements[0], /app-update=new-build/, "安全状態へ戻ったら自動再試行する");
}

{
  const offline = createRuntime({ online: false });
  await offline.runTimer();
  assert.equal(offline.fetchCount, 0, "オフライン中は確認せずアプリを壊さない");
  offline.navigator.onLine = true;
  offline.window.dispatchEvent(new TestEvent("online"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(offline.replacements[0], /app-update=new-build/, "オンライン復帰時に再確認する");
}

{
  const guarded = createRuntime({ previousAttempt: { build: "new-build", at: Date.now() } });
  await guarded.runTimer();
  assert.equal(guarded.replacements.length, 0, "同じbuildの連続reloadを防ぐ");
}

process.stdout.write("共通Web自動更新のcold start・同一build・通常ブラウザ・PWA・TWA・延期・オフライン・reload guardテストに成功しました。\n");
