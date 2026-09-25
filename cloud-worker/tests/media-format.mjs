import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/cloud/") });
let sessionCacheId = "session-a";
globalThis.TCloudSession = { check: () => ({ sessionCacheId }) };
await import("../public/media-format.js");
await import("../public/file-safety.js");

const format = globalThis.TCloudMediaFormat;
const bytes = (...values) => Uint8Array.from(values.flat());
const text = (value) => [...Buffer.from(value, "ascii")];
const mp4 = bytes(0, 0, 0, 24, text("ftyp"), text("isom"), 0, 0, 0, 0, text("isom"), text("mp42"));
const flv = bytes(text("FLV"), 1, 5, 0, 0, 0, 9);
const asf = bytes(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c);
const ts = new Uint8Array(188 * 3);
ts[0] = ts[188] = ts[376] = 0x47;

assert.equal(format.detectContainer(mp4).container, "mp4", "Case A: real MP4 is detected");
assert.equal(format.playbackMimeType({ name: "movie.mp4", mimeType: "video/mp4" }), "video/mp4", "Case A: legacy MP4 MIME is unchanged");
assert.equal(format.mpegContainerType({ name: "movie.mp4", containerType: "mp4" }), "", "Case A: MP4 remains native");

assert.equal(format.detectContainer(ts).container, "mpeg-ts", "Case B: MPEG-TS content wins over .mp4");
assert.equal(format.mpegContainerType({ name: "movie.mp4", containerType: "mpeg-ts" }), "m2ts");
assert.equal(format.playbackMimeType({ name: "movie.mp4", containerType: "mpeg-ts" }), "video/mp2t");

assert.equal(format.detectContainer(flv).container, "flv", "Case C: FLV content is detected");
assert.equal(format.mpegContainerType({ name: "movie.mp4", containerType: "flv" }), "flv");

assert.equal(format.detectContainer(asf).container, "asf", "Case D: ASF GUID is detected");
assert.notEqual(format.detectContainer(asf).container, "mp4");

assert.equal(format.mpegContainerType({ name: "movie.ts", containerType: "mp4" }), "", "Case E: real MP4 is not pinned to mpegts.js");
assert.equal(format.playbackMimeType({ name: "movie.ts", containerType: "mp4" }), "video/mp4");

assert.equal(format.detectContainer(bytes(1, 2, 3, 4, 5)).container, "unknown", "Case F: unknown is explicit");
assert.equal(format.normalizeContainer("unknown"), "");

function mockFile(name, content) {
  const blob = new Blob([content]);
  return { name, size: blob.size, slice: (...args) => blob.slice(...args) };
}
await assert.rejects(
  () => TCloudSafety.inspect(mockFile("movie.mp4", bytes(0x4d, 0x5a, 0, 0))),
  (error) => error.code === "SAFETY_CONFIRM_REQUIRED",
  "Case G: executable content disguised as video stays fail-closed"
);

let requests = 0;
globalThis.fetch = async (_url, options) => {
  requests += 1;
  assert.equal(options.headers.Range, `bytes=0-${format.SNIFF_BYTES - 1}`);
  return new Response(ts, {
    status: 206,
    headers: { "Content-Range": `bytes 0-${ts.byteLength - 1}/${ts.byteLength}`, "Content-Type": "video/mp4" }
  });
};
const stored = { id: 42, name: "legacy.mp4", sizeBytes: 400_000_000, updatedAt: "2026-09-25 00:00:00" };
assert.equal((await format.detectFromUrl("/cloud/local-media/abcdefghijklmnopqrstuv", stored)).container, "mpeg-ts", "Case H: encrypted legacy media is sniffed through the local gateway");
await format.detectFromUrl("/cloud/local-media/anotherabcdefghijklmnop", stored);
assert.equal(requests, 1, "same session/file/version reuses the detection cache");
sessionCacheId = "session-b";
await format.detectFromUrl("/cloud/local-media/abcdefghijklmnopqrstuv", stored);
assert.equal(requests, 2, "a session change invalidates cache reuse");

await assert.rejects(
  () => format.detectFromUrl("https://outside.example/video", stored),
  /端末内メディア経路/,
  "plaintext sniffing never uses an external URL"
);

const [mainSource, shareSource, mediaClientSource, mediaWorkerSource, serverSource, mainHtml, shareHtml, thumbnailSource] = await Promise.all([
  new URL("../public/cloud.js", import.meta.url),
  new URL("../public/share.js", import.meta.url),
  new URL("../public/media-client.js", import.meta.url),
  new URL("../public/media-worker.js", import.meta.url),
  new URL("../src/index.js", import.meta.url),
  new URL("../public/index.html", import.meta.url),
  new URL("../public/share.html", import.meta.url),
  new URL("../public/thumbnail-codec.js", import.meta.url)
].map((url) => readFile(url, "utf8")));
for (const source of [mainSource, shareSource]) {
  assert.match(source, /startPlayback\(false\)/, "existing native/dedicated route remains the first attempt");
  assert.match(source, /fallbackAttempted = true/);
  assert.match(source, /TCloudMediaFormat\.detectFromUrl\(url, file\)/);
  assert.match(source, /detected\.container === "unknown"/);
}
assert.match(mediaClientSource, /updateMediaFormat/);
assert.match(mediaWorkerSource, /MEDIA_FORMAT_UPDATED/);
assert.match(mediaWorkerSource, /if \(descriptor\.containerType\) return descriptor\.containerType === "mp4"/);
assert.match(serverSource, /\["\/media-format\.js", "\/media-format\.js"\]/);
assert.ok(mainHtml.indexOf("media-format.js") < mainHtml.indexOf("media-client.js"));
assert.ok(shareHtml.indexOf("media-format.js") < shareHtml.indexOf("media-client.js"));
assert.match(thumbnailSource, /container==="asf"/);
assert.doesNotMatch(mainSource, /TCloudThumbnailCodec[^\n]*loadVideoPlayerSource/, "LibAV remains thumbnail-only, not a full playback path");

console.log("native-first media container detection and local Range fallback: ok");
