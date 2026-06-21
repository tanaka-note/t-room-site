const CACHE_NAME = "t-room-kokoro-tenbin-v2";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./index.html?v=20260622-tenbin2",
  "./kokoro-tenbin.css?v=20260622-tenbin2",
  "./kokoro-tenbin.js?v=20260622-tenbin2",
  "./manifest.webmanifest",
  "./icon.svg"
];

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

  const isTenbinAsset = url.pathname.includes("/apps/kokoro-tenbin/");
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
