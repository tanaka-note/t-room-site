"use strict";

const CACHE_NAME = "asset-report-shell-asset-report-53aef79846c1";
const APP_PATH = "/asset-report-k7m4q9x2/";
const APP_SHELL = [
  APP_PATH,
  `${APP_PATH}index.html`,
  `${APP_PATH}icons/icon-192.png?v=20260812-2`,
  `${APP_PATH}icons/icon-512.png?v=20260812-2`,
  `${APP_PATH}icons/icon-maskable-512.png?v=20260812-2`,
  `${APP_PATH}icons/apple-touch-icon.png?v=20260812-2`,
  `${APP_PATH}icons/favicon-32.png?v=20260812-2`,
  "/asset-report-k7m4q9x2/manifest.webmanifest?v=asset-report-53aef79846c1",
  "/asset-report-k7m4q9x2/pwa.js?v=asset-report-53aef79846c1",
  "/asset-report-k7m4q9x2/report.css?v=asset-report-53aef79846c1",
  "/asset-report-k7m4q9x2/report.js?v=asset-report-53aef79846c1",
  "/assets/pwa-auto-update.js?v=asset-report-53aef79846c1"
];
const APP_SHELL_PATHS = new Set(APP_SHELL.map((value) => new URL(value, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith("asset-report-shell-") && key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(APP_PATH) && !APP_SHELL_PATHS.has(url.pathname)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match(`${APP_PATH}index.html`);
      return new Response("オフラインではこのデータを表示できません。", { status: 503 });
    }
  })());
});
