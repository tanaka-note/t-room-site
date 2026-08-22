const CACHE_NAME = "troom-diary-shell-diary-e6426ffae9d1";
const STATIC_ASSETS = [
  "/diary/icons/icon-192-v4.png?v=5",
  "/diary/icons/icon-512-v4.png?v=5",
  "/diary/icons/icon-maskable-512-v4.png?v=5",
  "/diary/icons/apple-touch-icon-v3.png?v=4",
  "/diary/icons/favicon-64-v4.png?v=5",
  "/assets/pwa-auto-update.js?v=diary-e6426ffae9d1",
  "/diary/diary.css?v=diary-e6426ffae9d1",
  "/diary/diary.js?v=diary-e6426ffae9d1",
  "/diary/investment.css?v=diary-e6426ffae9d1",
  "/diary/investment.js?v=diary-e6426ffae9d1",
  "/diary/manifest.webmanifest?v=diary-e6426ffae9d1",
  "/diary/troom-date-picker.css?v=diary-e6426ffae9d1",
  "/diary/troom-date-picker.js?v=diary-e6426ffae9d1",
  "/security/passkey-client.js?v=diary-e6426ffae9d1"
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
