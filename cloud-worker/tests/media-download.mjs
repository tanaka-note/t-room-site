import assert from "node:assert/strict";

globalThis.window = globalThis;
await import("../public/crypto-vault.js");
await import("../public/media-range.js");
await import("../public/media-client.js");

const chunkSize = 64 * 1024;
const source = new Uint8Array(chunkSize * 2 + 913);
for (let offset = 0; offset < source.byteLength; offset += 65_536) {
  crypto.getRandomValues(source.subarray(offset, Math.min(source.byteLength, offset + 65_536)));
}
const fileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const chunks = [];
for (let index = 0, offset = 0; offset < source.byteLength; index++, offset += chunkSize) {
  chunks.push(await TRoomCrypto.encryptFileChunk(fileKey, source.subarray(offset, offset + chunkSize), index));
}

const encryptedFile = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
for (let index = 0, offset = 0; index < chunks.length; offset += chunks[index].byteLength, index++) {
  encryptedFile.set(chunks[index], offset);
}

const originalFetch = globalThis.fetch;
let requestCount = 0;
let retried = false;
globalThis.fetch = async (_url, options) => {
  requestCount += 1;
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
  assert.ok(match, "Range header must be present");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!retried && start > 0) {
    retried = true;
    throw new TypeError("simulated transient network failure");
  }
  return new Response(encryptedFile.slice(start, end + 1), { status: 206 });
};

const writes = [];
let createWritableCalls = 0;
let closed = false;
let aborted = false;
const targetHandle = {
  async createWritable(options) {
    createWritableCalls += 1;
    if (options.mode === "exclusive") throw new TypeError("mode is unsupported");
    return {
      async write(bytes) { writes.push(new Uint8Array(bytes)); },
      async close() { closed = true; },
      async abort() { aborted = true; }
    };
  }
};

const progress = [];
try {
  await TCloudMedia.streamDownload({
    sizeBytes: source.byteLength,
    chunkSizeBytes: chunkSize,
    chunkCount: chunks.length,
    mimeType: "application/octet-stream"
  }, fileKey, "/cloud/api/files/test/content", targetHandle, {
    onProgress(completed, total) { progress.push([completed, total]); }
  });
} finally {
  globalThis.fetch = originalFetch;
}

const output = new Uint8Array(writes.reduce((sum, chunk) => sum + chunk.byteLength, 0));
for (let index = 0, offset = 0; index < writes.length; offset += writes[index].byteLength, index++) output.set(writes[index], offset);

assert.deepEqual(output, source, "decrypted output must match the original file");
assert.equal(createWritableCalls, 2, "unsupported exclusive mode must retry with compatible options");
assert.equal(retried, true, "a transient range failure must be retried");
assert.equal(requestCount, chunks.length + 1);
assert.equal(closed, true);
assert.equal(aborted, false);
assert.deepEqual(progress.at(-1), [source.byteLength, source.byteLength]);

console.log("streaming decrypt download: ok");
