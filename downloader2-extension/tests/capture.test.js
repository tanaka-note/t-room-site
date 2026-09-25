import assert from "node:assert/strict";
import test from "node:test";
import { classifyObservation, mergeCandidate } from "../capture/candidates.js";
import { normalizeHeaders, requestContext } from "../capture/request-context.js";

const observed = (url, contentType, extra = {}) => classifyObservation({
  url, contentType, status: 200, resourceType: "media", source: "webRequest",
  requestContext: requestContext("GET", { referer: "https://fixture.test/watch" }, "https://fixture.test"), ...extra
});

test("detects HLS, DASH, direct and extensionless media by response metadata", () => {
  assert.equal(observed("https://cdn.test/master.m3u8", "application/vnd.apple.mpegurl").kind, "hls");
  assert.equal(observed("https://cdn.test/video.mpd", "application/dash+xml").kind, "dash");
  assert.equal(observed("https://cdn.test/video.mp4", "video/mp4").kind, "direct");
  assert.equal(observed("https://cdn.test/api/media?id=1", "video/mp4").kind, "direct");
});

test("suppresses segment storms while retaining manifests and direct media", () => {
  assert.equal(classifyObservation({ url: "https://cdn.test/seg-1.ts", contentType: "video/mp2t", resourceType: "xmlhttprequest" }), null);
  assert.equal(classifyObservation({ url: "https://cdn.test/seg-1.m4s", contentType: "application/octet-stream", resourceType: "other" }), null);
  const first = observed("https://cdn.test/master.m3u8?token=one", "application/x-mpegurl");
  const second = observed("https://cdn.test/master.m3u8?token=two", "application/x-mpegurl", { source: "debugger" });
  assert.equal(first.key, second.key);
  assert.equal(mergeCandidate(first, second).source, "debugger");
});

test("captures required request context without logging or persistence transforms", () => {
  const headers = normalizeHeaders([
    { name: "Cookie", value: "session=local" }, { name: "Authorization", value: "Bearer local" },
    { name: "Referer", value: "https://fixture.test/watch" }, { name: "Origin", value: "https://fixture.test" },
    { name: "User-Agent", value: "Fixture Browser" }, { name: "X-Unrelated", value: "drop" }
  ]);
  assert.deepEqual(Object.keys(headers).sort(), ["authorization", "cookie", "origin", "referer", "user-agent"]);
  assert.equal(headers.cookie, "session=local");
});

test("Deep Capture observations use the same candidate path", () => {
  const candidate = observed("https://cdn.test/no-extension", "application/vnd.apple.mpegurl", { source: "debugger" });
  assert.equal(candidate.kind, "hls");
  assert.equal(candidate.source, "debugger");
});

test("only explicit DRM markers are rejected", () => {
  assert.equal(observed("https://cdn.test/encrypted.m3u8", "application/vnd.apple.mpegurl").drm, false);
  assert.equal(observed("https://cdn.test/manifest.mpd", "application/dash+xml", { drmSystem: "widevine" }).drm, true);
});
