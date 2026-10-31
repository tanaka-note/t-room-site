import assert from "node:assert/strict";
import { preparePhoto, preparePhotoBatch } from "../public/diary-photo-processing.js";

const originals = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap,
  setTimeout: globalThis.setTimeout, warn: console.warn, File: globalThis.File };
const diagnostics = [], waits = [];
let decode = async () => {};
globalThis.document = { createElement: () => ({
  getContext: () => ({ fillRect() {}, setTransform() {}, drawImage() {} }),
  toBlob: callback => callback(new Blob(["webp"], { type: "image/webp" }))
}) };
globalThis.createImageBitmap = async () => { await decode(); return { width: 4, height: 3, close() {} }; };
globalThis.setTimeout = (callback, ms) => { waits.push(ms); queueMicrotask(callback); };
console.warn = (...args) => diagnostics.push(args);
const file = (name = "private-provider-path.png", size = 16) => new File([new Uint8Array(size)], name, { type: "image/png" });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const release = photo => { if (photo) URL.revokeObjectURL(photo.previewUrl); };

try {
  const transient = file();
  let attempts = 0;
  transient.arrayBuffer = async () => {
    if (++attempts < 3) throw new DOMException("private-provider-path", "NotReadableError");
    return Blob.prototype.arrayBuffer.call(transient);
  };
  release(await preparePhoto(transient));
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [150, 450]);

  for (const [name, expectedAttempts] of [["NotReadableError", 3], ["SecurityError", 1], ["NotFoundError", 1], ["RangeError", 1]]) {
    const failing = file();
    let attempts = 0;
    const cause = name === "RangeError" ? new RangeError("private-provider-path") : new DOMException("private-provider-path", name);
    failing.arrayBuffer = async () => { attempts++; throw cause; };
    await assert.rejects(preparePhoto(failing), error => error.stage === "read" && error.cause === cause);
    assert.equal(attempts, expectedAttempts, name);
  }

  // A copy allocation failure must be classified separately and never retried.
  let rejectCopy = false;
  globalThis.File = class extends originals.File {
    constructor(...args) { super(...args); if (rejectCopy) throw new RangeError("private-provider-path"); }
  };
  const allocation = file();
  rejectCopy = true;
  await assert.rejects(preparePhoto(allocation), error => error.stage === "snapshot" && error.cause.name === "RangeError");
  globalThis.File = originals.File;

  // While decoding photo 0, photo 1 must already be owned, but photo 2 must
  // remain unread. A provider failure after that read cannot affect photo 1.
  const files = [file("0.png"), file("1.png"), file("2.png")];
  const reads = [];
  for (const f of files) f.arrayBuffer = async () => { reads.push(f.name); return Blob.prototype.arrayBuffer.call(f); };
  const entered = gate(), blocked = gate();
  let decodes = 0;
  decode = async () => { if (++decodes === 1) { entered.resolve(); await blocked.promise; } };
  const batch = preparePhotoBatch(files);
  const first = batch.next();
  await entered.promise;
  assert.deepEqual(reads, ["0.png", "1.png"]);
  files[1].arrayBuffer = async () => { throw new DOMException("provider reference expired", "NotReadableError"); };
  blocked.resolve();
  const results = [(await first).value];
  for await (const result of batch) results.push(result);
  assert.deepEqual(results.map(result => result.photo.fileName), ["0.png", "1.png", "2.png"]);
  for (const result of results) release(result.photo);

  // Original-byte budget includes the photo being converted. Oversized photos
  // are allowed singly, without adding a second read alongside them.
  for (const size of [9 * 1024 * 1024, 17 * 1024 * 1024]) {
    const sizes = size > 16 * 1024 * 1024 ? [size, 1] : [size, size];
    const files = sizes.map((size, i) => file(`${i}.png`, size));
    const reads = [];
    for (const f of files) f.arrayBuffer = async () => { reads.push(f.name); return Blob.prototype.arrayBuffer.call(f); };
    const entered = gate(), blocked = gate();
    let decodes = 0;
    decode = async () => { if (++decodes === 1) { entered.resolve(); await blocked.promise; } };
    const batch = preparePhotoBatch(files);
    const first = batch.next();
    await entered.promise;
    assert.deepEqual(reads, ["0.png"], `${size}: no read-ahead beyond the byte budget`);
    blocked.resolve();
    release((await first).value.photo);
    for await (const result of batch) { assert.ok(result.photo); release(result.photo); }
  }

  decode = async () => {};
  const broken = file("failed.png");
  broken.arrayBuffer = async () => { throw new DOMException("private-provider-path", "NotReadableError"); };
  const partial = [];
  for await (const result of preparePhotoBatch([file("first.png"), broken, file("last.png")])) partial.push(result);
  assert.deepEqual(partial.map(result => Boolean(result.photo)), [true, false, true]);
  assert.equal(partial[1].error.stage, "read");
  for (const result of partial) release(result.photo);
  // Decode failure must only fail its own photo, not abort later snapshots.
  let failNextDecode = true;
  decode = async () => {
    if (failNextDecode) {
      failNextDecode = false;
      throw new DOMException("private-provider-path", "EncodingError");
    }
  };
  const decodeResults = [];
  for await (const result of preparePhotoBatch([file("decode-fails.png"), file("decode-recovers.png")])) {
    decodeResults.push(result);
  }
  assert.deepEqual(decodeResults.map(result => Boolean(result.photo)), [false, true]);
  assert.equal(decodeResults[0].error.stage, "decode");
  release(decodeResults[1].photo);
  decode = async () => {};

  // The conversion path must close the bitmap and continue with later photos.
  let failNextConversion = true;
  let bitmapCloses = 0;
  globalThis.createImageBitmap = async () => ({ width: 4, height: 3, close() { bitmapCloses++; } });
  globalThis.document.createElement = () => ({
    getContext: () => ({ fillRect() {}, setTransform() {}, drawImage() {} }),
    toBlob: callback => {
      if (failNextConversion) { failNextConversion = false; callback(null); }
      else callback(new Blob(["webp"], { type: "image/webp" }));
    }
  });
  const convertResults = [];
  for await (const result of preparePhotoBatch([file("convert-fails.png"), file("convert-recovers.png")])) {
    convertResults.push(result);
  }
  assert.deepEqual(convertResults.map(result => Boolean(result.photo)), [false, true]);
  assert.equal(convertResults[0].error.stage, "convert");
  assert.equal(bitmapCloses, 2, "both failed and successful transformations must close their bitmaps");
  release(convertResults[1].photo);

  assert.doesNotMatch(JSON.stringify(diagnostics), /private-provider-path|\.png/);
  assert.ok(diagnostics.every(([label, details]) => label === "Diary photo preparation"
    && Object.keys(details).every(key => ["stage", "errorType", "attempt"].includes(key))));
  process.stdout.write("Photo preparation read-ahead, byte limits, finite retries, partial success, and private diagnostics passed.\n");
} finally {
  for (const key of ["document", "createImageBitmap"]) {
    if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key];
  }
  globalThis.File = originals.File;
  globalThis.setTimeout = originals.setTimeout;
  console.warn = originals.warn;
}
