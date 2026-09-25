import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const MIB = 1024 * 1024;
const CHUNK_SIZE = 8 * MIB;
const CHUNK_COUNT = 25;
const FILE_SIZE = 200 * MIB;
const source = readFileSync(new URL("../public/media-worker.js", import.meta.url), "utf8");
const events = {};
const stored = new Map();
const heldRequests = new Map();
const retryFailures = new Map();
const requests = [];
const workerMessages = [];
let session = "A";
let activeEncryptedRequests = 0;
let maxActiveEncryptedRequests = 0;
let holdNetwork = false;

const fakeCrypto = {
  async decryptFileChunk(_key, envelope, index) {
    assert.equal(envelope[0], index, `ciphertext marker for chunk ${index}`);
    return new Uint8Array(CHUNK_SIZE).fill(index).buffer;
  }
};

const context = vm.createContext({
  console,
  crypto,
  CryptoKey,
  Uint8Array,
  AbortController,
  DOMException,
  Headers,
  Response,
  ReadableStream,
  URL,
  TRoomCrypto: fakeCrypto,
  TCloudRange: await loadRangeHelpers(),
  setTimeout,
  setInterval() {},
  importScripts() {},
  fetch: async (url, options = {}) => {
    if (url === "/cloud/api/session") {
      const authenticated = session === options.headers["X-TCloud-Session"];
      return Response.json({ authenticated }, { status: authenticated ? 200 : 419 });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    assert.ok(match, "encrypted fetch uses a closed chunk Range");
    const index = Number(match[1]) / (CHUNK_SIZE + 32);
    assert.ok(Number.isInteger(index) && index >= 0 && index < CHUNK_COUNT);
    requests.push(index);
    activeEncryptedRequests += 1;
    maxActiveEncryptedRequests = Math.max(maxActiveEncryptedRequests, activeEncryptedRequests);
    try {
      if (holdNetwork) {
        await new Promise((resolve, reject) => {
          heldRequests.set(index, resolve);
          options.signal.addEventListener("abort", () => {
            heldRequests.delete(index);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      const failures = Number(retryFailures.get(index) || 0);
      if (failures > 0) {
        retryFailures.set(index, failures - 1);
        return new Response(null, { status: 503 });
      }
      return new Response(Uint8Array.of(index), { status: 206 });
    } finally {
      activeEncryptedRequests -= 1;
      heldRequests.delete(index);
    }
  }
});

context.self = context;
context.navigator = { onLine: true };
context.addEventListener = (name, handler) => { events[name] = handler; };
context.clients = { get: async () => ({ postMessage() {} }), matchAll: async () => [] };
context.TCloudOffline = {
  supported: () => true,
  getCacheLimitBytes: () => 1024 * MIB,
  setCacheLimitBytes() {},
  getChunk: async (id, index) => stored.get(`${id}:${index}`),
  putChunk: async (id, index, bytes) => { stored.set(`${id}:${index}`, bytes); }
};
vm.runInContext(`${source}\nglobalThis.test = { registrations, servePlainFile };`, context);

const fileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["decrypt"]);
const descriptor = {
  endpoint: "/cloud/api/files/1/view",
  expectedSession: "A",
  name: "long-fixture.mp4",
  sizeBytes: FILE_SIZE,
  chunkSizeBytes: CHUNK_SIZE,
  chunkCount: CHUNK_COUNT,
  encryptedSizeBytes: FILE_SIZE + CHUNK_COUNT * 32,
  storageId: "A:long-fixture",
  mimeType: "video/mp4"
};
const owner = "owner";
const token = "longrangetokenfixture1234";

await send("REGISTER_MEDIA", token, { descriptor, fileKey });
await send("UPDATE_MEDIA_FORMAT", token, { containerType: "mpeg-ts", mimeType: "video/mp2t" });
assert.equal(context.test.registrations.get(token).descriptor.mimeType, "video/mp2t", "detected MPEG-TS updates the local response MIME");
assert.equal(workerMessages.at(-1)?.type, "MEDIA_FORMAT_UPDATED", "format update is acknowledged before player retry");
await send("UPDATE_MEDIA_FORMAT", token, { containerType: "mp4", mimeType: "video/mp4" });
assert.equal(context.test.registrations.get(token).descriptor.containerType, "mp4", "real MP4 keeps MP4 Range behavior after format confirmation");
maxActiveEncryptedRequests = 0;
send("MEDIA_PLAYING", token);
await until(() => stored.size === CHUNK_COUNT);
assert.equal(maxActiveEncryptedRequests, 4, "persistent background prefetch keeps four encrypted requests in flight");
assert.equal(stored.has(`${descriptor.storageId}:${CHUNK_COUNT - 1}`), true, "200MiB prefetch reaches EOF");

const response = await context.test.servePlainFile(
  token,
  new Request(`https://local/cloud/local-media/${token}`, { headers: { Range: "bytes=0-" } }),
  owner
);
assert.equal(response.status, 206);
assert.equal(response.headers.get("Content-Range"), `bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
assert.equal(Number(response.headers.get("Content-Length")), FILE_SIZE);
const full = await consume(response, 0, FILE_SIZE);
assert.equal(full.crossed64MiB, true, "stream crosses the former 64MiB response boundary");
assert.equal(full.crossed128MiB, true, "stream crosses 128MiB without a new response");
assert.equal(full.total, FILE_SIZE, "open-ended Range reaches EOF");

const entry = context.test.registrations.get(token);
assert.ok(entry.decryptedCacheBytes <= 96 * MIB, "plaintext cache stays within 96MiB");
assert.ok(entry.decryptedChunks.size <= 12, "8MiB plaintext chunks remain bounded");

const seekStart = 17 * CHUNK_SIZE + 123;
const seekResponse = await context.test.servePlainFile(
  token,
  new Request(`https://local/cloud/local-media/${token}`, { headers: { Range: `bytes=${seekStart}-` } }),
  owner
);
assert.equal(seekResponse.headers.get("Content-Range"), `bytes ${seekStart}-${FILE_SIZE - 1}/${FILE_SIZE}`);
const seek = await consume(seekResponse, seekStart, FILE_SIZE - seekStart);
assert.equal(seek.firstByte, 17, "seek starts from the requested encrypted chunk");
assert.equal(seek.total, FILE_SIZE - seekStart, "seeked open-ended Range also reaches EOF");

const closedEnd = seekStart + MIB - 1;
const closed = await context.test.servePlainFile(
  token,
  new Request(`https://local/cloud/local-media/${token}`, { headers: { Range: `bytes=${seekStart}-${closedEnd}` } }),
  owner
);
assert.equal(Number(closed.headers.get("Content-Length")), MIB, "explicit seek Range remains explicitly bounded");
assert.equal((await consume(closed, seekStart, MIB)).total, MIB);

const retryToken = "retryfixturetoken12345678";
const retryStorageId = "A:retry";
const retriesBefore = requests.filter((index) => index === 5).length;
retryFailures.set(5, 1);
await send("REGISTER_MEDIA", retryToken, { descriptor: { ...descriptor, storageId: retryStorageId }, fileKey });
send("MEDIA_PLAYING", retryToken);
await until(() => stored.has(`${retryStorageId}:5`));
assert.equal(requests.filter((index) => index === 5).length - retriesBefore, 2, "transient encrypted range failure is retried");
send("RELEASE_MEDIA", retryToken);

const staleResponse = await context.test.servePlainFile(
  token,
  new Request(`https://local/cloud/local-media/${token}`, { headers: { Range: "bytes=0-" } }),
  owner
);
const staleReader = staleResponse.body.getReader();
assert.equal((await staleReader.read()).done, false);
session = "B";
await assert.rejects(staleReader.read(), /Session changed/, "session change stops an active EOF stream immediately");
assert.equal(context.test.registrations.has(token), false);

session = "A";
stored.clear();
holdNetwork = true;
const releaseToken = "releasefixturetoken123456";
send("REGISTER_MEDIA", releaseToken, { descriptor: { ...descriptor, storageId: "A:release" }, fileKey });
await until(() => heldRequests.size > 0);
send("RELEASE_MEDIA", releaseToken);
const requestCountAfterRelease = requests.length;
await until(() => heldRequests.size === 0 && activeEncryptedRequests === 0);
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(requests.length, requestCountAfterRelease, "RELEASE_MEDIA leaves no encrypted network work running");
assert.equal(context.test.registrations.has(releaseToken), false);

console.log("PASS 200MiB MP4 streams past 64/128MiB to EOF, seek/session/retry/release remain safe, four-way prefetch reaches EOF, plaintext RAM stays bounded");

async function loadRangeHelpers() {
  const savedWindow = globalThis.window;
  globalThis.window = globalThis;
  await import("../public/media-range.js");
  const helpers = globalThis.TCloudRange;
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
  return helpers;
}

function send(type, targetToken, extra = {}) {
  const waits = [];
  events.message({
    data: { type, token: targetToken, ...extra },
    source: { id: owner, postMessage(message) { workerMessages.push(message); } },
    waitUntil(promise) { waits.push(Promise.resolve(promise)); }
  });
  return Promise.all(waits);
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for media worker state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function consume(streamResponse, start, expectedLength) {
  const reader = streamResponse.body.getReader();
  let total = 0;
  let firstByte = null;
  let crossed64MiB = false;
  let crossed128MiB = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstByte === null && value.byteLength) firstByte = value[0];
    total += value.byteLength;
    crossed64MiB ||= start + total > 64 * MIB;
    crossed128MiB ||= start + total > 128 * MIB;
  }
  assert.equal(total, expectedLength);
  return { total, firstByte, crossed64MiB, crossed128MiB };
}
