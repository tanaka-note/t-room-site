const CACHE_NAME = "t-room-calculator-install-v5";
const APP_SHELL = [
  "./apps.html",
  "./styles.css?v=20260622-tenbin1",
  "./site.js?v=20260622-tenbin1",
  "./calculator-install.webmanifest",
  "./apps/calculator/index.html?v=20260621-remake10",
  "./apps/calculator/calculator.css?v=20260621-remake10",
  "./apps/calculator/calculator.js?v=20260621-remake10",
  "./apps/calculator/manifest.webmanifest",
  "./apps/calculator/icon-192.png",
  "./apps/calculator/icon-512.png",
  "./apps/calculator/icon.svg",
  "./apps/omikuji/index.html?v=20260621-omikuji1",
  "./apps/omikuji/omikuji.css?v=20260621-omikuji1",
  "./apps/omikuji/omikuji.js?v=20260621-omikuji1",
  "./apps/omikuji/manifest.webmanifest",
  "./apps/omikuji/icon-192.png",
  "./apps/omikuji/icon-512.png",
  "./apps/omikuji/icon.svg",
  "./apps/kokoro-tenbin/index.html?v=20260622-tenbin2",
  "./apps/kokoro-tenbin/kokoro-tenbin.css?v=20260622-tenbin2",
  "./apps/kokoro-tenbin/kokoro-tenbin.js?v=20260622-tenbin2",
  "./apps/kokoro-tenbin/manifest.webmanifest",
  "./apps/kokoro-tenbin/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key.startsWith("t-room-calculator-install-"))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isAppEntry = url.pathname.endsWith("/apps.html");
  const isCalculatorAsset = url.pathname.includes("/apps/calculator/");
  const isOmikujiAsset = url.pathname.includes("/apps/omikuji/");
  const isTenbinAsset = url.pathname.includes("/apps/kokoro-tenbin/");
  const isInstallAsset = url.pathname.endsWith("/calculator-install.webmanifest")
    || url.pathname.endsWith("/calculator-install-sw.js")
    || url.pathname.endsWith("/site.js")
    || url.pathname.endsWith("/styles.css");

  if (!isAppEntry && !isCalculatorAsset && !isOmikujiAsset && !isTenbinAsset && !isInstallAsset) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
