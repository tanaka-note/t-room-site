const CACHE_NAME = "t-room-kokoro-tenbin-kokoro-tenbin-038767b8ecae";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./index.html?v=kokoro-tenbin-038767b8ecae",
  "./icon.svg",
  "/apps/kokoro-tenbin/kokoro-tenbin.css?v=kokoro-tenbin-038767b8ecae",
  "/apps/kokoro-tenbin/kokoro-tenbin.js?v=kokoro-tenbin-038767b8ecae",
  "/apps/kokoro-tenbin/manifest.webmanifest?v=kokoro-tenbin-038767b8ecae",
  "/assets/pwa-auto-update.js?v=kokoro-tenbin-038767b8ecae"
];
const APP_ASSET_PATHS = new Set(APP_ASSETS.map((value) => new URL(value, self.location.origin).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key.startsWith("t-room-kokoro-tenbin-"))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isTenbinAsset = url.pathname.includes("/apps/kokoro-tenbin/") || APP_ASSET_PATHS.has(url.pathname);
  if (!isTenbinAsset) return;

  const isNavigation = event.request.mode === "navigate"
    || url.pathname.endsWith("/apps/kokoro-tenbin/")
    || url.pathname.endsWith("/apps/kokoro-tenbin/index.html");

  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
