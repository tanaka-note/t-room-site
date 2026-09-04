import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateUsageRows,
  classifyUsageError,
  estimateDownloaderCost,
  isParentUsageSession,
  jstUsageDate
} from "../src/downloader-usage.js";

test("利用状況は第一管理者のpasskey owner sessionだけに許可する", () => {
  const parent = { identityId: "primary-admin", serviceAccountId: "owner", authMethod: "passkey" };
  assert.equal(isParentUsageSession(parent, "owner"), true);
  assert.equal(isParentUsageSession({ ...parent, identityId: "family-user" }, "owner"), false);
  assert.equal(isParentUsageSession({ ...parent, serviceAccountId: "member" }, "owner"), false);
  assert.equal(isParentUsageSession({ ...parent, authMethod: "password" }, "owner"), false);
  assert.equal(isParentUsageSession(parent, "subadmin"), false);
});

test("日次境界は日本時間で決定する", () => {
  assert.equal(jstUsageDate(Date.parse("2026-09-03T14:59:59Z")), "2026-09-03");
  assert.equal(jstUsageDate(Date.parse("2026-09-03T15:00:00Z")), "2026-09-04");
});

test("security failureを秘匿可能な固定分類へ正規化する", () => {
  assert.deepEqual(classifyUsageError({ message: "scan_malware_detected" }), { code: "scan_malware_detected", outcome: "failed", category: "malware_detected" });
  assert.equal(classifyUsageError({ message: "scan_yara_detected" }).category, "yara_detected");
  assert.equal(classifyUsageError({ message: "scan_malware_scanner_unavailable" }).category, "scanner_unavailable");
  assert.equal(classifyUsageError({ message: "scan_yara_scan_timeout" }).category, "scanner_timeout");
  assert.equal(classifyUsageError({ message: "scan_mime_mismatch" }).category, "file_type_mismatch");
  assert.equal(classifyUsageError({ message: "scan_normalization_failed" }).category, "malformed_media");
  assert.equal(classifyUsageError({ message: "download_tls_failed" }).category, "tls_failed");
  assert.equal(classifyUsageError({ message: "download_network_failed" }).category, "network_failed");
  assert.equal(classifyUsageError({ message: "format_unavailable" }).category, "malformed_media");
  assert.equal(classifyUsageError({ message: "scanner_rejected" }).category, "scanner_rejected");
  assert.equal(classifyUsageError({ code: "processing_budget_exceeded", status: 422 }).category, "processing_budget_exceeded");
  assert.equal(classifyUsageError({ message: "job_deadline_exceeded" }).category, "deadline_exceeded");
  assert.deepEqual(classifyUsageError({ code: "rate_limited", status: 429 }), { code: "rate_limited", outcome: "rejected", category: "rate_limited" });
  assert.equal(classifyUsageError({ code: "ssrf_blocked", status: 403 }).category, "ssrf_rejected");
  assert.equal(classifyUsageError({ message: "secret/path?token=x" }).code, "unknown");
});

test("日次行を今日・今月・累計表示用の値へ集計する", () => {
  const usage = aggregateUsageRows([
    { metric: "request", dimension: "analyze", event_count: 3 },
    { metric: "request", dimension: "download", event_count: 2 },
    { metric: "result", dimension: "success", event_count: 1 },
    { metric: "delivery", dimension: "started", event_count: 2, byte_count: 4096 },
    { metric: "normalization", dimension: "PASS_THROUGH", event_count: 1 },
    { metric: "security", dimension: "rate_limited", event_count: 2 },
    { metric: "outcome", dimension: "rejected", event_count: 2 },
    { metric: "platform", dimension: "queue_read", event_count: 4 },
    { metric: "resource", dimension: "container_cpu_ms", value_sum: 2500 },
    { metric: "resource", dimension: "container_peak_rss", value_max: 1024 }
  ]);
  assert.equal(usage.analyzeRequests, 3);
  assert.equal(usage.downloadRequests, 2);
  assert.equal(usage.fileDeliveryStarts, 2);
  assert.equal(usage.deliveredBytes, 4096);
  assert.equal(usage.normalization.PASS_THROUGH, 1);
  assert.equal(usage.security.rate_limited, 2);
  assert.equal(usage.platform.queueReads, 4);
  assert.equal(usage.container.cpuMs, 2500);
  assert.equal(usage.container.peakRssBytes, 1024);
});

test("推定料金はDownloader単独の付帯枠超過分だけを算出する", () => {
  const usage = aggregateUsageRows([
    { metric: "platform", dimension: "worker_request", event_count: 10_000_001 },
    { metric: "platform", dimension: "queue_read", event_count: 1_000_001 },
    { metric: "platform", dimension: "r2_class_a", event_count: 1_000_001 },
    { metric: "resource", dimension: "container_cpu_ms", value_sum: 22_501_000 }
  ]);
  const estimate = estimateDownloaderCost(usage);
  assert.ok(estimate.estimatedAdditionalUsd > 0);
  assert.equal(estimate.currency, "USD");
  assert.equal(estimate.complete, false);
  assert.match(estimate.notes.join(" "), /正式な請求額はCloudflare Billing/);
  assert.equal(estimate.components.find((item) => item.name === "Workers requests").estimatedAdditionalUsd, 0.0000003);
  assert.equal(estimate.components.find((item) => item.name === "R2 Class A").estimatedAdditionalUsd, 4.50);
  assert.equal(estimate.components.find((item) => item.name === "Workers CPU").available, false);
  assert.equal(estimate.components.find((item) => item.name === "D1 rows read").estimatedAdditionalUsd, null);
});
