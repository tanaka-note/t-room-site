/* T-Cloud Storage local decrypting media gateway.
 * Decryption keys live only in this Service Worker process and are never
 * persisted or sent to Cloudflare. */
importScripts("/cloud/crypto-vault.js?v=cloud-76d0412cd6a5");
importScripts("/cloud/media-range.js?v=cloud-76d0412cd6a5");
importScripts("/cloud/offline-store.js?v=cloud-76d0412cd6a5");

const registrations = new Map();
const RETRY_DELAYS = [0, 400, 1200, 3000];
const APP_SHELL_CACHE = "tcloud-shell-cloud-76d0412cd6a5";
const MEDIA_WORKER_BUILD_ID = "cloud-76d0412cd6a5";
const DECRYPTED_CACHE_LIMIT_BYTES = 96 * 1024 * 1024;
const DEMAND_PREFETCH_CHUNKS = 4;
const PREFETCH_CONCURRENCY = 2;
const MP4_METADATA_WARM_CHUNKS = 4;
const MP4_RANGE_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const MP4_PLAYING_RANGE_LIMIT_BYTES = 8 * 1024 * 1024;
const OFFLINE_URL = "/cloud/offline";
const APP_SHELL_ASSETS = [
  OFFLINE_URL,
  "/cloud/manifest.webmanifest",
  "/cloud/offline-store.js?v=cloud-76d0412cd6a5",
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
    if (previous && previous.ownerClientId !== event.source?.id) return;
    if (previous) releaseEntry(previous);
    if (Number(data.cacheLimitBytes) > 0) self.TCloudOffline?.setCacheLimitBytes(Number(data.cacheLimitBytes));
    const entry = {
      descriptor: data.descriptor,
      ownerClientId: event.source?.id,
      token: data.token,
      controller: new AbortController(),
      fileKey: data.fileKey,
      decryptedChunks: new Map(),
      decryptingChunks: new Map(),
      encryptedChunkTasks: new Map(),
      prefetchControllers: new Map(),
      prefetchedChunks: new Set(),
      demandCount: 0,
      prefetchAnchor: 0,
      decryptedCacheBytes: 0,
      cacheWriteChain: Promise.resolve(),
      touchedAt: Date.now(),
      released: false
    };
    registrations.set(data.token, entry);
    event.source?.postMessage({ type: "MEDIA_REGISTERED", token: data.token, workerBuild: MEDIA_WORKER_BUILD_ID });
    event.waitUntil(warmMediaForPlayback(data.token, entry).catch(() => {}));
  } else if (data.type === "MEDIA_PLAYING") {
    const entry = registrations.get(data.token);
    if (entry && entry.ownerClientId === event.source?.id) entry.playing = true;
  } else if (data.type === "SET_CACHE_LIMIT" && Number(data.cacheLimitBytes) > 0) {
    self.TCloudOffline?.setCacheLimitBytes(Number(data.cacheLimitBytes));
  } else if (data.type === "RELEASE_MEDIA" && typeof data.token === "string") {
    const entry = registrations.get(data.token);
    if (entry && entry.ownerClientId === event.source?.id) { releaseEntry(entry); registrations.delete(data.token); }
  } else if (data.type === "CLEAR_MEDIA") {
    for (const [token, entry] of registrations) {
      if (entry.ownerClientId === event.source?.id) { releaseEntry(entry); registrations.delete(token); }
    }
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/cloud\/local-media\/([A-Za-z0-9_-]{22,64})$/);
  if (match) {
    event.respondWith(servePlainFile(match[1], event.request, event.clientId));
    return;
  }
  if (event.request.mode === "navigate" && url.origin === self.location.origin && url.pathname.startsWith("/cloud/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
  }
});

async function servePlainFile(token, request, clientId) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...noStoreHeaders(), "Allow": "GET, HEAD" } });
  }
  const entry = await resolveRegistration(token, clientId);
  if (!entry) {
    void reportMediaFailure(token, "registration", new Error("Media key is unavailable"));
    return new Response("Media key is unavailable", { status: 410, headers: noStoreHeaders() });
  }
  if (entry.ownerClientId !== clientId) return new Response("Media owner mismatch", {status:403, headers:noStoreHeaders()});
  try { await verifyMediaSession(entry); } catch { return new Response("Session changed", {status:419, headers:noStoreHeaders()}); }
  entry.touchedAt = Date.now();
  const descriptor = entry.descriptor;
  const size = Number(descriptor.sizeBytes);
  const rangeHeader = request.headers.get("Range");
  const requested = constrainOpenEndedMp4Range(entry, rangeHeader, TCloudRange.parsePlainRange(rangeHeader, size));
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
  const body = request.method === "HEAD" ? null : decryptedRangeStream(token, entry, start, end);
  return new Response(body, { status: partial ? 206 : 200, headers });
}

function decryptedRangeStream(token, entry, start, end) {
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
        await verifyMediaSession(entry);
        const { from, to } = TCloudRange.plainChunkSlice(index, plain.byteLength, start, end, chunkSize);
        assertActive(entry);
        controller.enqueue(plain.slice(from, to));
        index += 1;
      } catch (error) {
        void reportMediaFailure(token, "decrypt-range", error);
        controller.error(error);
      }
    },
    cancel() { index = lastChunk + 1; }
  });
}

async function fetchAndDecryptChunk(entry, index, options = {}) {
  if (options.prefetch) return getDecryptedChunk(entry, index, options);
  entry.demandCount = Number(entry.demandCount || 0) + 1;
  entry.prefetchAnchor = index;
  // A playback/seek request never queues behind speculative network work.
  // Promote the same chunk; abort other speculative transfers immediately.
  for (const [candidate, controller] of entry.prefetchControllers || []) {
    if (candidate !== index) controller.abort();
    else entry.prefetchControllers.delete(candidate);
  }
  try {
    return await getDecryptedChunk(entry, index, options);
  } finally {
    entry.demandCount -= 1;
    prefetchUpcomingChunks(entry, index, DEMAND_PREFETCH_CHUNKS);
  }
}

async function getDecryptedChunk(entry, index, options = {}) {
  await verifyMediaSession(entry);
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
    assertActive(entry);
    rememberDecryptedChunk(entry, index, plain);
    return plain;
  } finally {
    entry.decryptingChunks?.delete(index);
  }
}

function constrainOpenEndedMp4Range(entry, rangeHeader, requested) {
  if (!requested?.partial || !/^bytes=\d+-$/.test(String(rangeHeader || "")) || !isMp4Descriptor(entry.descriptor)) {
    return requested;
  }
  const limit = entry.playing ? MP4_PLAYING_RANGE_LIMIT_BYTES : MP4_RANGE_RESPONSE_LIMIT_BYTES;
  return { ...requested, end: Math.min(requested.end, requested.start + limit - 1) };
}

async function loadAndDecryptChunk(entry, index, options = {}) {
  const envelope = await loadEncryptedChunk(entry, index);
  assertActive(entry);
  const plain = new Uint8Array(await TRoomCrypto.decryptFileChunk(entry.fileKey, envelope, index));
  assertActive(entry);
  return plain;
}

async function loadEncryptedChunk(entry, index, signal) {
  assertActive(entry);
  if (signal?.aborted) throw new DOMException("Prefetch yielded", "AbortError");
  const file = entry.descriptor;
  if (file.storageId && self.TCloudOffline?.supported()) {
    const cached = await self.TCloudOffline.getChunk(file.storageId, index).catch(() => null);
    if (cached) return cached;
  }
  if (file.offlineOnly) throw new Error("Offline media chunk is unavailable");
  const pending = entry.encryptedChunkTasks?.get(index);
  if (pending) {
    try { return await pending; } catch (error) {
      if (signal || entry.released || error.name !== "AbortError") throw error;
      // A demand may arrive just after a speculative task was cancelled.
      return loadEncryptedChunk(entry, index);
    }
  }
  const task = fetchAndCacheEncryptedChunk(entry, index, signal);
  entry.encryptedChunkTasks?.set(index, task);
  try {
    return await task;
  } finally {
    entry.encryptedChunkTasks?.delete(index);
  }
}

async function fetchAndCacheEncryptedChunk(entry, index, signal) {
  const file = entry.descriptor;
  const { start, end } = TCloudRange.encryptedChunkRange(file, index);
  let lastError;
  for (const delay of RETRY_DELAYS) {
    if (delay) await wait(delay);
    try {
      assertActive(entry);
      if (signal?.aborted) throw new DOMException("Prefetch yielded", "AbortError");
      const response = await fetch(file.endpoint, {
        headers: { Range: `bytes=${start}-${end}`, ...(file.expectedSession ? {"X-TCloud-Session":file.expectedSession} : {}) },
        signal: signal || entry.controller?.signal,
        credentials: "same-origin",
        cache: "no-store"
      });
      if ([401, 419].includes(response.status)) { invalidateMediaSession(entry); throw new Error("Session changed"); }
      assertActive(entry);
      if (response.status !== 206) throw new Error(`Encrypted range request failed (${response.status})`);
      const envelope = new Uint8Array(await response.arrayBuffer());
      assertActive(entry);
      if (file.storageId && self.TCloudOffline?.supported()) {
        entry.cacheWriteChain = Promise.resolve(entry.cacheWriteChain)
          .catch(() => {})
          .then(() => { assertActive(entry); return self.TCloudOffline.putChunk(file.storageId, index, envelope, { expectedBytes: end - start + 1 }); });
        // Backpressure speculative writes without delaying playback on storage.
        if (signal) await entry.cacheWriteChain.catch(() => {});
      }
      return envelope;
    } catch (error) {
      if (entry.released || error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Encrypted range request failed");
}

function prefetchUpcomingChunks(entry, index, count) {
  if (entry.released || !entry.prefetchReady || entry.prefetchTask) return;
  entry.prefetchTask = runEncryptedPrefetch(entry, count).catch(() => {}).finally(() => { entry.prefetchTask = null; });
}

async function runEncryptedPrefetch(entry, nearCount) {
  const file = entry.descriptor;
  if (file.offlineOnly) return;
  const persistent = file.storageId && self.TCloudOffline?.supported();
  const visited = entry.prefetchedChunks;
  const work = async () => {
    while (!entry.released) {
      if (entry.demandCount) { await wait(25); continue; }
      const chunkSize = Number(file.chunkSizeBytes || 8 * 1024 * 1024);
      const limit = Number(self.TCloudOffline?.getCacheLimitBytes?.() || 1024 * 1024 * 1024);
      const windowChunks = persistent ? Math.max(1, Math.floor(limit / (chunkSize + 32))) : nearCount + 1;
      const start = Number(entry.prefetchAnchor || 0) + 1;
      const end = Math.min(Number(file.chunkCount), start + windowChunks - 1);
      // Nearest four first, then continue toward EOF within the cache window.
      let index = start;
      const nearEnd = Math.min(end, start + nearCount);
      while (index < nearEnd && visited.has(index)) index += 1;
      while (index < end && visited.has(index)) index += 1;
      if (index >= end) return;
      visited.add(index);
      const controller = new AbortController();
      entry.prefetchControllers.set(index, controller);
      const abort = () => controller.abort();
      entry.controller.signal.addEventListener("abort", abort, { once: true });
      try {
        const envelope = await loadEncryptedChunk(entry, index, controller.signal);
        if (!persistent) {
          assertActive(entry);
          const plain = new Uint8Array(await TRoomCrypto.decryptFileChunk(entry.fileKey, envelope, index));
          assertActive(entry);
          rememberDecryptedChunk(entry, index, plain);
        }
      } catch (error) {
        if (error.name === "AbortError") visited.delete(index);
      } finally {
        entry.controller.signal.removeEventListener("abort", abort);
        entry.prefetchControllers.delete(index);
      }
    }
  };
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, work));
}

async function warmMediaForPlayback(token, entry) {
  const descriptor = entry.descriptor;
  const chunkCount = Number(descriptor.chunkCount || 0);
  if (!chunkCount || entry.released) return;
  const edgeIndexes = [0];
  if (shouldWarmTail(descriptor) && chunkCount > 1) edgeIndexes.push(chunkCount - 1);
  await Promise.all(edgeIndexes.map((index) => fetchAndDecryptChunk(entry, index, { prefetch: true }).catch(() => null)));
  if (isMp4Descriptor(descriptor)) await warmMp4Metadata(entry).catch(() => {});
  await Promise.resolve(entry.cacheWriteChain).catch(() => {});
  if (entry.released || registrations.get(token) !== entry || descriptor.offlineOnly) return;
  entry.prefetchReady = true;
  prefetchUpcomingChunks(entry, entry.prefetchAnchor, DEMAND_PREFETCH_CHUNKS);
  await entry.prefetchTask;
}

async function warmMp4Metadata(entry) {
  const descriptor = entry.descriptor;
  const fileSize = Number(descriptor.sizeBytes || 0);
  const chunkSize = Number(descriptor.chunkSizeBytes || 8 * 1024 * 1024);
  if (!fileSize || !chunkSize) return;
  let offset = 0;
  for (let boxIndex = 0; boxIndex < 128 && offset + 8 <= fileSize; boxIndex += 1) {
    const header = await readPlainBytes(entry, offset, 16);
    if (header.byteLength < 8) return;
    const size32 = readUint32Be(header, 0);
    const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (header.byteLength < 16) return;
      boxSize = readUint64Be(header, 8);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = fileSize - offset;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || offset + boxSize > fileSize) return;
    if (type === "moov") {
      const firstChunk = Math.floor(offset / chunkSize);
      const lastChunk = Math.min(Number(descriptor.chunkCount || 1) - 1, firstChunk + MP4_METADATA_WARM_CHUNKS - 1);
      for (let index = firstChunk; index <= lastChunk; index += 2) {
        await Promise.all([index, index + 1]
          .filter((candidate) => candidate <= lastChunk)
          .map((candidate) => fetchAndDecryptChunk(entry, candidate, { prefetch: true }).catch(() => null)));
      }
      return;
    }
    offset += boxSize;
  }
}

async function readPlainBytes(entry, start, length) {
  const descriptor = entry.descriptor;
  const fileSize = Number(descriptor.sizeBytes || 0);
  const chunkSize = Number(descriptor.chunkSizeBytes || 8 * 1024 * 1024);
  if (start < 0 || start >= fileSize || length <= 0) return new Uint8Array(0);
  const end = Math.min(fileSize, start + length);
  const output = new Uint8Array(end - start);
  let written = 0;
  let position = start;
  while (position < end) {
    const index = Math.floor(position / chunkSize);
    const plain = await fetchAndDecryptChunk(entry, index, { prefetch: true });
    const from = position - index * chunkSize;
    const count = Math.min(end - position, plain.byteLength - from);
    if (count <= 0) break;
    output.set(plain.subarray(from, from + count), written);
    written += count;
    position += count;
  }
  return written === output.byteLength ? output : output.subarray(0, written);
}

function readUint32Be(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function readUint64Be(bytes, offset) {
  const high = readUint32Be(bytes, offset);
  const low = readUint32Be(bytes, offset + 4);
  const value = high * 0x100000000 + low;
  return Number.isSafeInteger(value) ? value : NaN;
}

async function reportMediaFailure(token, phase, error) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({
      type: "MEDIA_PLAYBACK_FAILURE",
      token,
      phase,
      workerBuild: MEDIA_WORKER_BUILD_ID,
      message: String(error?.message || error || "Unknown media error").slice(0, 240)
    });
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

async function resolveRegistration(token, clientId) {
  let entry = registrations.get(token);
  if (entry) return entry;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) if (client.id === clientId) client.postMessage({ type: "MEDIA_KEY_REQUIRED", token });
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
    && (String(file.endpoint).startsWith("/cloud/api/public/") || file.offlineOnly || typeof file.expectedSession === "string" && file.expectedSession.length > 0)
    && Number.isSafeInteger(Number(file.sizeBytes)) && Number(file.sizeBytes) >= 0
    && Number.isSafeInteger(Number(file.chunkSizeBytes)) && Number(file.chunkSizeBytes) > 0;
}

function releaseEntry(entry) {
  entry.released = true;
  entry.controller?.abort(); entry.fileKey = null;
  for (const bytes of entry.decryptedChunks?.values() || []) bytes.fill(0);
  entry.decryptedChunks?.clear(); entry.decryptingChunks?.clear(); entry.encryptedChunkTasks?.clear();
}
function assertActive(entry) { if (entry.released) throw new DOMException("Media released", "AbortError"); }
function invalidateMediaSession(entry) {
  releaseEntry(entry);
  registrations.delete(entry.token);
  void self.clients.get(entry.ownerClientId).then(client => client?.postMessage({type:"MEDIA_SESSION_INVALID", token:entry.token}));
}
async function verifyMediaSession(entry) {
  assertActive(entry);
  const file = entry.descriptor;
  if (!file.expectedSession || (file.offlineOnly && self.navigator?.onLine === false)) return;
  // Cached plaintext must also be checked. Network ranges independently carry
  // the same constraint, so changing the Cookie after this check cannot expand access.
  const response = await fetch("/cloud/api/session", {headers:{"X-TCloud-Session":file.expectedSession}, credentials:"same-origin", cache:"no-store", signal:entry.controller?.signal});
  if (!response.ok || !(await response.json()).authenticated) { invalidateMediaSession(entry); throw new Error("Session changed"); }
  assertActive(entry);
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
  for (const [token, entry] of registrations) if (entry.touchedAt < cutoff) { releaseEntry(entry); registrations.delete(token); }
}, 5 * 60 * 1000);
