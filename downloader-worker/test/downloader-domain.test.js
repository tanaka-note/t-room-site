import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainError,
  QUEUE_MAX_RETRIES,
  isFinalQueueAttempt,
  isPolicyRestrictedAnalysis,
  isPolicyRestrictedHost,
  normalizeClientRequestId,
  normalizeMediaId,
  normalizeSourceUrl,
  queueRetryDelaySeconds,
  sanitizeFilename,
  sourcePathHint
} from "../src/downloader-domain.js";

test("HTTP/HTTPSの公開URLだけを受け付ける", () => {
  assert.equal(normalizeSourceUrl("https://example.com/media?id=1#part").href, "https://example.com/media?id=1");
  for (const value of [
    "file:///etc/passwd", "ftp://example.com/a", "data:text/plain,a", "http://localhost/a",
    "http://127.0.0.1/a", "http://10.0.0.1/a", "http://169.254.169.254/latest",
    "http://192.168.1.1/a", "http://100.64.0.1/a", "http://0.0.0.0/a",
    "http://[::1]/a", "http://[fc00::1]/a", "http://[fe80::1]/a",
    "http://[::ffff:127.0.0.1]/a", "https://host.local/a", "https://host.internal/a",
    "https://user:secret@example.com/a", "https://example.com:8443/a"
  ]) assert.throws(() => normalizeSourceUrl(value), DomainError, value);
});

test("Queueの最終attemptはinitial + max_retriesの次である", () => {
  assert.equal(QUEUE_MAX_RETRIES, 3);
  assert.equal(isFinalQueueAttempt(1), false);
  assert.equal(isFinalQueueAttempt(3), false);
  assert.equal(isFinalQueueAttempt(4), true);
  assert.equal(queueRetryDelaySeconds(1), 30);
  assert.equal(queueRetryDelaySeconds(2), 60);
  assert.equal(queueRetryDelaySeconds(4), 240);
});

test("URLの監査用情報にqueryやfragmentを含めない", () => {
  const url = normalizeSourceUrl("https://cdn.example.com/private/item/file.mp4?token=secret#x");
  assert.equal(sourcePathHint(url), "/private/item/file.mp4");
  assert.doesNotMatch(sourcePathHint(url), /secret/);
});

test("YouTube関連ホストはGeneric取得ポリシーから除外する", () => {
  for (const host of ["youtube.com", "www.youtube.com", "youtu.be", "youtube-nocookie.com", "r3.googlevideo.com"]) {
    assert.equal(isPolicyRestrictedHost(host), true, host);
  }
  assert.equal(isPolicyRestrictedHost("example.com"), false);
  assert.equal(isPolicyRestrictedAnalysis({ finalHostname: "r3.googlevideo.com", extractor: "direct" }), true);
  assert.equal(isPolicyRestrictedAnalysis({ finalHostname: "cdn.example.com", extractor: "youtube" }), true);
  assert.equal(isPolicyRestrictedAnalysis({ finalHostname: "cdn.example.com", extractor: "html-generic" }), false);
});

test("ファイル名をContent-Disposition向けに正規化する", () => {
  assert.equal(sanitizeFilename("../../movie.mp4\r\nX-Test: yes"), "_._movie.mp4X-Test_ yes");
  assert.equal(sanitizeFilename("movie.mp4.exe"), "movie.mp4.exe");
  assert.ok(sanitizeFilename("a".repeat(500) + ".mp4").length <= 120);
});

test("request IDとmedia IDを許可文字だけに制限する", () => {
  assert.equal(normalizeClientRequestId("request_123"), "request_123");
  assert.equal(normalizeClientRequestId("short"), "");
  assert.equal(normalizeMediaId("a:b+c.1"), "a:b+c.1");
  assert.equal(normalizeMediaId("../../etc/passwd"), "");
});
