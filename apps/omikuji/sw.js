const CACHE_NAME = "t-room-omikuji-omikuji-542eea212b19";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./index.html?v=omikuji-542eea212b19",
  "./icon-192.png",
  "./icon-512.png",
  "./icon.svg",
  "/apps/omikuji/manifest.webmanifest?v=omikuji-542eea212b19",
  "/apps/omikuji/omikuji.css?v=omikuji-542eea212b19",
  "/apps/omikuji/omikuji.js?v=omikuji-542eea212b19",
  "/assets/pwa-auto-update.js?v=omikuji-542eea212b19"
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
          .filter((key) => key !== CACHE_NAME && key.startsWith("t-room-omikuji-"))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isOmikujiAsset = url.pathname.includes("/apps/omikuji/") || APP_ASSET_PATHS.has(url.pathname);
  if (!isOmikujiAsset) return;

  const isNavigation = event.request.mode === "navigate"
    || url.pathname.endsWith("/apps/omikuji/")
    || url.pathname.endsWith("/apps/omikuji/index.html");

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
