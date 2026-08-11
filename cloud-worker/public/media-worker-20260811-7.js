/* T-Cloud Storage local decrypting media gateway.
 * Decryption keys live only in this Service Worker process and are never
 * persisted or sent to Cloudflare. */
importScripts("/cloud/crypto-vault.js?v=20260808-7");
importScripts("/cloud/media-range.js?v=20260808-1");
importScripts("/cloud/offline-store.js?v=20260811-2");

const registrations = new Map();
const RETRY_DELAYS = [0, 400, 1200, 3000];
const APP_SHELL_CACHE = "tcloud-shell-20260811-7";
const DECRYPTED_CACHE_LIMIT_BYTES = 96 * 1024 * 1024;
const DEMAND_PREFETCH_CHUNKS = 3;
const BACKGROUND_PREFETCH_DELAY_MS = 350;
const OFFLINE_URL = "/cloud/offline";
const APP_SHELL_ASSETS = [
  OFFLINE_URL,
  "/cloud/manifest.webmanifest",
  "/cloud/offline-store.js?v=20260811-2",
  "/cloud/icons/icon-192-v3.png?rev=20260811-3",
  "/cloud/icons/icon-512-v3.png?rev=20260811-3",
  "/cloud/icons/icon-maskable-512-v3.png?rev=20260811-3"
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
  if (data.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  } else if (data.type === "REGISTER_MEDIA" && validRegistration(data)) {
    const previous = registrations.get(data.token);
    if (previous) previous.released = true;
    if (Number(data.cacheLimitBytes) > 0) self.TCloudOffline?.setCacheLimitBytes(Number(data.cacheLimitBytes));
    const entry = {
      descriptor: data.descriptor,
      fileKey: data.fileKey,
      decryptedChunks: new Map(),
      decryptingChunks: new Map(),
      encryptedChunkTasks: new Map(),
      decryptedCacheBytes: 0,
      cacheWriteChain: Promise.resolve(),
      touchedAt: Date.now(),
      released: false
    };
    registrations.set(data.token, entry);
    event.source?.postMessage({ type: "MEDIA_REGISTERED", token: data.token });
    event.waitUntil(warmMediaForPlayback(data.token, entry).catch(() => {}));
  } else if (data.type === "SET_CACHE_LIMIT" && Number(data.cacheLimitBytes) > 0) {
    self.TCloudOffline?.setCacheLimitBytes(Number(data.cacheLimitBytes));
  } else if (data.type === "RELEASE_MEDIA" && typeof data.token === "string") {
    const entry = registrations.get(data.token);
    if (entry) entry.released = true;
    registrations.delete(data.token);
  } else if (data.type === "CLEAR_MEDIA") {
    for (const entry of registrations.values()) entry.released = true;
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
  const rangeHeader = request.headers.get("Range");
  const requested = constrainOpenEndedMp4Range(descriptor, rangeHeader, TCloudRange.parsePlainRange(rangeHeader, size));
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

async function fetchAndDecryptChunk(entry, index, options = {}) {
  const cachedPlain = entry.decryptedChunks?.get(index);
  if (cachedPlain) {
    entry.decryptedChunks.delete(index);
    entry.decryptedChunks.set(index, cachedPlain);
    return cachedPlain;
  }
  const pending = entry.decryptingChunks?.get(index);
  if (pending) return pending;
  const task = loadAndDecryptChunk(entry, index, options);
  entry.decryptingChunks?.set(index, task);
  try {
    const plain = await task;
    rememberDecryptedChunk(entry, index, plain);
    if (!options.prefetch) prefetchUpcomingChunks(entry, index, DEMAND_PREFETCH_CHUNKS);
    return plain;
  } finally {
    entry.decryptingChunks?.delete(index);
  }
}

function constrainOpenEndedMp4Range(descriptor, rangeHeader, requested) {
  if (!requested?.partial || !/^bytes=\d+-$/.test(String(rangeHeader || "")) || !isMp4Descriptor(descriptor)) {
    return requested;
  }
  const chunkSize = Number(descriptor.chunkSizeBytes || 8 * 1024 * 1024);
  return { ...requested, end: Math.min(requested.end, requested.start + chunkSize - 1) };
}

async function loadAndDecryptChunk(entry, index, options = {}) {
  const envelope = await loadEncryptedChunk(entry, index);
  return new Uint8Array(await TRoomCrypto.decryptFileChunk(entry.fileKey, envelope, index));
}

async function loadEncryptedChunk(entry, index) {
  const file = entry.descriptor;
  if (file.storageId && self.TCloudOffline?.supported()) {
    const cached = await self.TCloudOffline.getChunk(file.storageId, index).catch(() => null);
    if (cached) return cached;
  }
  if (file.offlineOnly) throw new Error("Offline media chunk is unavailable");
  const pending = entry.encryptedChunkTasks?.get(index);
  if (pending) return pending;
  const task = fetchAndCacheEncryptedChunk(entry, index);
  entry.encryptedChunkTasks?.set(index, task);
  try {
    return await task;
  } finally {
    entry.encryptedChunkTasks?.delete(index);
  }
}

async function fetchAndCacheEncryptedChunk(entry, index) {
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
      const envelope = new Uint8Array(await response.arrayBuffer());
      if (file.storageId && self.TCloudOffline?.supported()) {
        entry.cacheWriteChain = Promise.resolve(entry.cacheWriteChain)
          .catch(() => {})
          .then(() => self.TCloudOffline.putChunk(file.storageId, index, envelope, { expectedBytes: end - start + 1 }));
      }
      return envelope;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Encrypted range request failed");
}

function prefetchUpcomingChunks(entry, index, count) {
  if (entry.released) return;
  const chunkCount = Number(entry.descriptor.chunkCount || 0);
  const indexes = [];
  for (let offset = 1; offset <= count && index + offset < chunkCount; offset += 1) indexes.push(index + offset);
  if (!indexes.length) return;
  void (async () => {
    for (const nextIndex of indexes) {
      if (entry.released) return;
      await fetchAndDecryptChunk(entry, nextIndex, { prefetch: true }).catch(() => null);
    }
  })();
}

async function warmMediaForPlayback(token, entry) {
  const descriptor = entry.descriptor;
  const chunkCount = Number(descriptor.chunkCount || 0);
  if (!chunkCount || entry.released) return;
  const edgeIndexes = [0];
  if (shouldWarmTail(descriptor) && chunkCount > 1) edgeIndexes.push(chunkCount - 1);
  await Promise.all(edgeIndexes.map((index) => fetchAndDecryptChunk(entry, index, { prefetch: true }).catch(() => null)));
  await Promise.resolve(entry.cacheWriteChain).catch(() => {});
  if (entry.released || registrations.get(token) !== entry || descriptor.offlineOnly || !descriptor.storageId) return;
  await wait(BACKGROUND_PREFETCH_DELAY_MS);
  const chunkSize = Number(descriptor.chunkSizeBytes || 8 * 1024 * 1024);
  const cacheLimit = Number(self.TCloudOffline?.getCacheLimitBytes?.() || 1024 * 1024 * 1024);
  const maxChunks = Math.min(chunkCount, Math.max(1, Math.floor(cacheLimit / Math.max(1, chunkSize + 32))));
  for (let index = 1; index < maxChunks; index += 1) {
    if (entry.released || registrations.get(token) !== entry) return;
    await loadEncryptedChunk(entry, index).catch(() => null);
    await Promise.resolve(entry.cacheWriteChain).catch(() => {});
    await wait(0);
  }
}

function shouldWarmTail(descriptor) {
  return isMp4Descriptor(descriptor)
    || /^(video\/(quicktime|webm)|audio\/mp4)$/i.test(String(descriptor.mimeType || ""));
}

function isMp4Descriptor(descriptor) {
  return /^(video|audio)\/mp4$/i.test(String(descriptor.mimeType || ""))
    || /\.(mp4|m4v)$/i.test(String(descriptor.name || ""));
}

function rememberDecryptedChunk(entry, index, bytes) {
  if (!entry.decryptedChunks) entry.decryptedChunks = new Map();
  const previous = entry.decryptedChunks.get(index);
  if (previous) entry.decryptedCacheBytes = Math.max(0, Number(entry.decryptedCacheBytes || 0) - previous.byteLength);
  entry.decryptedChunks.delete(index);
  entry.decryptedChunks.set(index, bytes);
  entry.decryptedCacheBytes = Number(entry.decryptedCacheBytes || 0) + bytes.byteLength;
  while (entry.decryptedCacheBytes > DECRYPTED_CACHE_LIMIT_BYTES && entry.decryptedChunks.size > 1) {
    const oldestIndex = entry.decryptedChunks.keys().next().value;
    const oldest = entry.decryptedChunks.get(oldestIndex);
    entry.decryptedChunks.delete(oldestIndex);
    entry.decryptedCacheBytes = Math.max(0, entry.decryptedCacheBytes - Number(oldest?.byteLength || 0));
  }
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
