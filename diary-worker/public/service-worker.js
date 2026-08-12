const CACHE_NAME = "troom-diary-shell-v8";
const STATIC_ASSETS = [
  "/diary/diary.css?v=14",
  "/diary/diary.js?v=21",
  "/diary/manifest.webmanifest",
  "/diary/icons/icon-192.png",
  "/diary/icons/icon-512.png",
  "/diary/icons/apple-touch-icon.png",
  "/diary/icons/favicon-64.png"
];
const STATIC_PATHS = new Set(STATIC_ASSETS.map((value) => new URL(value, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith("troom-diary-shell-") && key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !STATIC_PATHS.has(url.pathname)) return;

  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(request)) || new Response("Offline", { status: 503 })));
});
