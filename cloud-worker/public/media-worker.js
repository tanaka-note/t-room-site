/* T-Cloud Storage local decrypting media gateway.
 * Decryption keys live only in this Service Worker process and are never
 * persisted or sent to Cloudflare. */
importScripts("/cloud/crypto-vault.js?v=20260808-7");
importScripts("/cloud/media-range.js?v=20260808-1");

const registrations = new Map();
const RETRY_DELAYS = [0, 400, 1200, 3000];
const APP_SHELL_CACHE = "tcloud-shell-20260810-3";
const OFFLINE_URL = "/cloud/offline";
const APP_SHELL_ASSETS = [
  OFFLINE_URL,
  "/cloud/manifest.webmanifest?v=20260810-2",
  "/cloud/icons/icon-192.png",
  "/cloud/icons/icon-512.png",
  "/cloud/icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => event.waitUntil((async () => {
  const cache = await caches.open(APP_SHELL_CACHE);
  await cache.addAll(APP_SHELL_ASSETS);
  await self.skipWaiting();
})()));
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.filter((name) => name.startsWith("tcloud-shell-") && name !== APP_SHELL_CACHE).map((name) => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "REGISTER_MEDIA" && validRegistration(data)) {
    registrations.set(data.token, {
      descriptor: data.descriptor,
      fileKey: data.fileKey,
      touchedAt: Date.now()
    });
    event.source?.postMessage({ type: "MEDIA_REGISTERED", token: data.token });
  } else if (data.type === "RELEASE_MEDIA" && typeof data.token === "string") {
    registrations.delete(data.token);
  } else if (data.type === "CLEAR_MEDIA") {
    registrations.clear();
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/cloud\/local-media\/([A-Za-z0-9_-]{22,64})$/);
  if (match) {
    event.respondWith(servePlainFile(match[1], event.request));
    return;
  }
  if (event.request.mode === "navigate" && url.origin === self.location.origin && url.pathname.startsWith("/cloud/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
  }
});

async function servePlainFile(token, request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...noStoreHeaders(), "Allow": "GET, HEAD" } });
  }
  const entry = await resolveRegistration(token);
  if (!entry) return new Response("Media key is unavailable", { status: 410, headers: noStoreHeaders() });
  entry.touchedAt = Date.now();
  const descriptor = entry.descriptor;
  const size = Number(descriptor.sizeBytes);
  const requested = TCloudRange.parsePlainRange(request.headers.get("Range"), size);
  if (!requested) {
    return new Response(null, {
      status: 416,
      headers: { ...noStoreHeaders(), "Content-Range": `bytes */${size}` }
    });
  }
  const { start, end, partial } = requested;
  const headers = new Headers(noStoreHeaders());
  headers.set("Content-Type", descriptor.mimeType || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(end - start + 1));
  if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const body = request.method === "HEAD" ? null : decryptedRangeStream(entry, start, end);
  return new Response(body, { status: partial ? 206 : 200, headers });
}

function decryptedRangeStream(entry, start, end) {
  const descriptor = entry.descriptor;
  const chunkSize = Number(descriptor.chunkSizeBytes || 8 * 1024 * 1024);
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor(end / chunkSize);
  let index = firstChunk;
  return new ReadableStream({
    async pull(controller) {
      if (index > lastChunk) {
        controller.close();
        return;
      }
      try {
        const plain = await fetchAndDecryptChunk(entry, index);
        const { from, to } = TCloudRange.plainChunkSlice(index, plain.byteLength, start, end, chunkSize);
        controller.enqueue(plain.subarray(from, to));
        index += 1;
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { index = lastChunk + 1; }
  });
}

async function fetchAndDecryptChunk(entry, index) {
  const file = entry.descriptor;
  const { start, end } = TCloudRange.encryptedChunkRange(file, index);
  let lastError;
  for (const delay of RETRY_DELAYS) {
    if (delay) await wait(delay);
    try {
      const response = await fetch(file.endpoint, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: "same-origin",
        cache: "no-store"
      });
      if (response.status !== 206) throw new Error(`Encrypted range request failed (${response.status})`);
      const envelope = await response.arrayBuffer();
      return new Uint8Array(await TRoomCrypto.decryptFileChunk(entry.fileKey, envelope, index));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Encrypted range request failed");
}

async function resolveRegistration(token) {
  let entry = registrations.get(token);
  if (entry) return entry;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "MEDIA_KEY_REQUIRED", token });
  for (let attempt = 0; attempt < 40 && !entry; attempt++) {
    await wait(50);
    entry = registrations.get(token);
  }
  return entry || null;
}

function validRegistration(data) {
  const file = data.descriptor || {};
  return typeof data.token === "string"
    && /^[A-Za-z0-9_-]{22,64}$/.test(data.token)
    && data.fileKey instanceof CryptoKey
    && file.endpoint && String(file.endpoint).startsWith("/cloud/api/")
    && Number.isSafeInteger(Number(file.sizeBytes)) && Number(file.sizeBytes) >= 0
    && Number.isSafeInteger(Number(file.chunkSizeBytes)) && Number(file.chunkSizeBytes) > 0;
}

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin"
  };
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [token, entry] of registrations) if (entry.touchedAt < cutoff) registrations.delete(token);
}, 5 * 60 * 1000);
