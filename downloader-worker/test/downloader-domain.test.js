import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainError,
  DOWNLOAD_TTL_SECONDS,
  ORPHAN_OBJECT_GRACE_MS,
  QUEUE_MAX_RETRIES,
  exceedsVideoTranscodeBudget,
  isFinalQueueAttempt,
  isPolicyRestrictedAnalysis,
  isPolicyRestrictedHost,
  normalizeClientRequestId,
  normalizeContainerErrorCode,
  normalizeMediaId,
  normalizeSourceUrl,
  orphanObjectIsPastGrace,
  publicJob,
  queueRetryDelaySeconds,
  sanitizeFilename
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

test("公開jobから内部取得capabilityとsource pathを除外する", () => {
  const job = publicJob({
    id: "job", status: "analyzed", source_hostname: "media.example", source_path_hint: "/private/item",
    progress_stage: "scanning",
    analysis_json: JSON.stringify({ title: "clip", media: [], _sealedRoutes: { direct: { sourceCiphertext: "secret" } } }),
  });
  assert.equal(job.sourcePathHint, null);
  assert.equal(job.analysis.title, "clip");
  assert.equal("_sealedRoutes" in job.analysis, false);
  assert.equal(job.progressStage, null, "non-processing jobs must not expose stale progress");
  assert.equal(publicJob({ ...job, id: "processing", status: "processing", source_hostname: "media.example", progress_stage: "scanning", analysis_json: "{}" }).progressStage, "scanning");
  assert.equal(publicJob({ ...job, id: "invalid", status: "processing", source_hostname: "media.example", progress_stage: "<script>", analysis_json: "{}" }).progressStage, null);
});

test("R2成果物は12時間だけ保持する", () => {
  assert.equal(DOWNLOAD_TTL_SECONDS, 12 * 60 * 60);
});

test("作成直後のR2成果物をorphan cleanupから保護する", () => {
  const now = Date.parse("2026-09-05T03:00:00Z");
  assert.equal(ORPHAN_OBJECT_GRACE_MS, 15 * 60 * 1000);
  assert.equal(orphanObjectIsPastGrace(new Date(now - ORPHAN_OBJECT_GRACE_MS + 1), now), false);
  assert.equal(orphanObjectIsPastGrace(new Date(now - ORPHAN_OBJECT_GRACE_MS), now), true);
  assert.equal(orphanObjectIsPastGrace("invalid", now), false, "unknown timestamps must be retained");
});

test("映像再エンコードが処理枠を超える場合だけ事前拒否する", () => {
  assert.equal(exceedsVideoTranscodeBudget({ mediaType: "video", videoCodec: "vp9", audioCodec: "aac", duration: 600, width: 1920, height: 1080, fps: 30 }), true);
  assert.equal(exceedsVideoTranscodeBudget({ mediaType: "video", videoCodec: "hevc", audioCodec: "aac", duration: 600, width: 1920, height: 1080, fps: 30 }), true);
  assert.equal(exceedsVideoTranscodeBudget({ mediaType: "video", videoCodec: "h264", audioCodec: "opus", duration: 3600, width: 3840, height: 2160, fps: 60 }), false);
  assert.equal(exceedsVideoTranscodeBudget({ mediaType: "audio", videoCodec: "none", audioCodec: "opus", duration: 3600 }), false);
  assert.equal(exceedsVideoTranscodeBudget({ mediaType: "video", videoCodec: "vp9", audioCodec: "opus", duration: 60, width: 1280, height: 720, fps: 30 }), false);
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

test("Containerの安全なerror codeだけをQueueログへ引き継ぐ", () => {
  assert.equal(normalizeContainerErrorCode("job_deadline_exceeded", 503), "job_deadline_exceeded");
  assert.equal(normalizeContainerErrorCode("yara_scan_timeout", 422), "yara_scan_timeout");
  assert.equal(normalizeContainerErrorCode("secret/path?token=value", 503), "container_503");
  assert.equal(normalizeContainerErrorCode("", 999), "container_500");
});
