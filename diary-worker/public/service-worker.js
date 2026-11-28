const CACHE_NAME = "troom-diary-shell-diary-f9f5ab4be2be";
const STATIC_ASSETS = [
  "/diary/diary-photo-save.js?v=diary-f9f5ab4be2be",
  "/diary/diary-photo-processing.js?v=diary-f9f5ab4be2be",
  "/diary/diary-photo-upload.js?v=diary-f9f5ab4be2be",
  "/diary/diary-photo-images.js?v=diary-f9f5ab4be2be",
  "/diary/diary-photo-viewer.js?v=diary-f9f5ab4be2be",
  "/diary/diary-rich-text.js?v=diary-f9f5ab4be2be",
  "/diary/diary-weather.js?v=diary-f9f5ab4be2be",
  "/diary/icons/icon-192-v4.png?v=5",
  "/diary/icons/icon-512-v4.png?v=5",
  "/diary/icons/icon-maskable-512-v4.png?v=5",
  "/diary/icons/apple-touch-icon-v3.png?v=4",
  "/diary/icons/favicon-64-v4.png?v=5",
  "/diary/diary-search.js?v=diary-f9f5ab4be2be",
  "/diary/dialog-navigation.js?v=diary-f9f5ab4be2be",
  "/diary/diary.js?v=diary-f9f5ab4be2be",
  "/diary/troom-date-picker.js?v=diary-f9f5ab4be2be",
  "/assets/pwa-auto-update.js?v=diary-f9f5ab4be2be",
  "/diary/diary-bootstrap.js?v=diary-f9f5ab4be2be",
  "/diary/diary.css?v=diary-f9f5ab4be2be",
  "/diary/manifest.webmanifest?v=diary-f9f5ab4be2be",
  "/diary/tlain-login.css?v=diary-f9f5ab4be2be",
  "/diary/tlain-login.js?v=diary-f9f5ab4be2be",
  "/diary/troom-date-picker.css?v=diary-f9f5ab4be2be",
  "/security/passkey-client.js?v=diary-f9f5ab4be2be"
];
// Only exact build URLs for public code/styles/icons may bypass the network.
const CACHEABLE_ASSETS = STATIC_ASSETS.filter(value => {
  const url = new URL(value, self.location.origin);
  return /\.(?:js|css|png)$/.test(url.pathname);
});
const STATIC_URLS = new Set(CACHEABLE_ASSETS.map(value => new URL(value, self.location.origin).href));
const LOGIN_ASSETS = CACHEABLE_ASSETS.filter(value =>
  !/\/(?:diary(?:-search|-photo-processing|-photo-upload|-photo-images|-photo-viewer|-photo-save|-rich-text|-weather)?|dialog-navigation|troom-date-picker)\.js\?/.test(value));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async cache => {
    await Promise.all(LOGIN_ASSETS.map(async value => {
      const response = await fetch(value);
      if (canCache(response)) await cache.put(value, response);
      else await response.body?.cancel();
    }));
  }));
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
  if (url.origin !== self.location.origin || !STATIC_URLS.has(url.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (canCache(response)) {
        event.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    } catch {
      return new Response("Offline", { status: 503 });
    }
  })());
});

function canCache(response) {
  return response.ok && !response.redirected
    && !/\b(?:no-store|private)\b/i.test(response.headers.get("Cache-Control") || "");
}
