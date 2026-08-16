const CACHE_NAME = "t-room-motivation-switch-motivation-switch-0f6f7d8d8b00";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./index.html?v=motivation-switch-0f6f7d8d8b00",
  "./icon.svg",
  "../../assets/site-icon-192.png",
  "../../assets/apple-touch-icon.png",
  "/apps/motivation-switch/manifest.webmanifest?v=motivation-switch-0f6f7d8d8b00",
  "/assets/pwa-auto-update.js?v=motivation-switch-0f6f7d8d8b00"
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
          .filter((key) => key !== CACHE_NAME && key.startsWith("t-room-motivation-switch-"))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isSwitchAsset = url.pathname.includes("/apps/motivation-switch/")
    || url.pathname.endsWith("/assets/site-icon-192.png")
    || url.pathname.endsWith("/assets/apple-touch-icon.png")
    || APP_ASSET_PATHS.has(url.pathname);
  if (!isSwitchAsset) return;

  const isNavigation = event.request.mode === "navigate"
    || url.pathname.endsWith("/apps/motivation-switch/")
    || url.pathname.endsWith("/apps/motivation-switch/index.html");

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
