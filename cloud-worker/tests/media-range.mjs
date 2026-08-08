import assert from "node:assert/strict";
await import("../public/media-range.js");

const range = globalThis.TCloudRange;
assert.deepEqual(range.parsePlainRange(null, 100), { start: 0, end: 99, partial: false });
assert.deepEqual(range.parsePlainRange("bytes=0-0", 100), { start: 0, end: 0, partial: true });
assert.deepEqual(range.parsePlainRange("bytes=10-29", 100), { start: 10, end: 29, partial: true });
assert.deepEqual(range.parsePlainRange("bytes=90-", 100), { start: 90, end: 99, partial: true });
assert.deepEqual(range.parsePlainRange("bytes=-10", 100), { start: 90, end: 99, partial: true });
assert.equal(range.parsePlainRange("bytes=100-110", 100), null);
assert.equal(range.parsePlainRange("bytes=30-20", 100), null);
assert.equal(range.parsePlainRange("bytes=0-1,4-5", 100), null);

const file = { sizeBytes: 20, chunkSizeBytes: 8 };
assert.deepEqual(range.encryptedChunkRange(file, 0), { start: 0, end: 39, plainLength: 8 });
assert.deepEqual(range.encryptedChunkRange(file, 1), { start: 40, end: 79, plainLength: 8 });
assert.deepEqual(range.encryptedChunkRange(file, 2), { start: 80, end: 115, plainLength: 4 });
assert.deepEqual(range.plainChunkSlice(1, 8, 10, 18, 8), { from: 2, to: 8 });
assert.deepEqual(range.plainChunkSlice(2, 4, 10, 18, 8), { from: 0, to: 3 });

console.log("media range mapping: ok");
