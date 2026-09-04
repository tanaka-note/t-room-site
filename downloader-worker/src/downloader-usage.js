export const PRIMARY_ADMIN_IDENTITY_ID = "primary-admin";

export const DOWNLOADER_PRICING = Object.freeze({
  currency: "USD",
  asOf: "2026-09-04",
  workers: Object.freeze({
    includedRequests: 10_000_000,
    requestPerMillion: 0.30,
    includedCpuMs: 30_000_000,
    cpuPerMillionMs: 0.02
  }),
  containers: Object.freeze({
    includedCpuSeconds: 375 * 60,
    cpuPerSecond: 0.000020,
    includedMemoryGibSeconds: 25 * 60 * 60,
    memoryPerGibSecond: 0.0000025,
    includedDiskGbSeconds: 200 * 60 * 60,
    diskPerGbSecond: 0.00000007,
    includedNetworkBytes: 500 * 1_000_000_000,
    conservativeNetworkPerGb: 0.05
  }),
  queues: Object.freeze({ includedOperations: 1_000_000, operationPerMillion: 0.40 }),
  r2: Object.freeze({
    includedStorageGbMonth: 10,
    storagePerGbMonth: 0.015,
    includedClassA: 1_000_000,
    classAPerMillion: 4.50,
    includedClassB: 10_000_000,
    classBPerMillion: 0.36
  }),
  d1: Object.freeze({
    includedRowsRead: 25_000_000_000,
    rowsReadPerMillion: 0.001,
    includedRowsWritten: 50_000_000,
    rowsWrittenPerMillion: 1.00,
    includedStorageGb: 5,
    storagePerGbMonth: 0.75
  })
});

const NORMALIZATION_MODES = Object.freeze([
  "PASS_THROUGH", "REMUX", "PARTIAL_TRANSCODE", "FULL_TRANSCODE", "NOT_APPLICABLE", "UNKNOWN"
]);

const SECURITY_CATEGORIES = Object.freeze([
  "malware_detected", "yara_detected", "clamav_error", "yara_error", "scanner_timeout",
  "scanner_unavailable", "file_type_mismatch", "malformed_media", "processing_budget_exceeded",
  "deadline_exceeded", "ssrf_rejected", "rate_limited", "other_reject", "other_failed"
]);

export function isParentUsageSession(session, serverRole = "owner") {
  return session?.identityId === PRIMARY_ADMIN_IDENTITY_ID &&
    session?.serviceAccountId === "owner" && session?.authMethod === "passkey" && serverRole === "owner";
}

export function jstUsageDate(value = Date.now()) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError("invalid usage date");
  return new Date(milliseconds + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function jstUsageMonth(value = Date.now()) {
  return jstUsageDate(value).slice(0, 7);
}

export function classifyUsageError(error) {
  const code = String(error?.code || error?.message || "unknown").trim().toLowerCase().slice(0, 120);
  const status = Number(error?.status || 0);
  const outcome = status >= 400 && status < 500 ? "rejected" : "failed";
  let category;
  if (code.includes("yara_detected")) category = "yara_detected";
  else if (code.includes("malware_detected")) category = "malware_detected";
  else if (/(malware_scan_timeout|yara_scan_timeout)/.test(code)) category = "scanner_timeout";
  else if (/(malware_scanner_unavailable|yara_unavailable)/.test(code)) category = "scanner_unavailable";
  else if (/(malware_definitions_|malware_scan_failed|malware_scan_incomplete)/.test(code)) category = "clamav_error";
  else if (/(yara_rules_invalid|yara_scan_failed)/.test(code)) category = "yara_error";
  else if (/(mime_mismatch|extension_mismatch|unsupported_mime|executable_content|blocked_extension|suspicious_double_extension|magic_failed)/.test(code)) category = "file_type_mismatch";
  else if (/(ffprobe_|invalid_media_stream|unsafe_embedded_stream|normalized_|normalization_|manifest_invalid)/.test(code)) category = "malformed_media";
  else if (/(processing_budget_exceeded|video_transcode_budget)/.test(code)) category = "processing_budget_exceeded";
  else if (/(job_deadline_exceeded|download_timeout|metadata_timeout)/.test(code)) category = "deadline_exceeded";
  else if (/(ssrf_blocked|blocked_address|blocked_hostname|blocked_port|credentials_not_allowed|dns_failed|invalid_dns_result)/.test(code)) category = "ssrf_rejected";
  else if (code.includes("rate_limited")) category = "rate_limited";
  else category = outcome === "rejected" ? "other_reject" : "other_failed";
  return { code: /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "unknown", outcome, category };
}

export function aggregateUsageRows(rows = []) {
  const value = {
    analyzeRequests: 0,
    downloadRequests: 0,
    processingSuccesses: 0,
    fileDeliveryStarts: 0,
    deleted: 0,
    expired: 0,
    sourceBytes: 0,
    r2StoredBytes: 0,
    deliveredBytes: 0,
    rejected: 0,
    failed: 0,
    normalization: Object.fromEntries(NORMALIZATION_MODES.map((name) => [name, 0])),
    security: Object.fromEntries(SECURITY_CATEGORIES.map((name) => [name, 0])),
    platform: { workerRequests: 0, queueWrites: 0, queueReads: 0, queueDeletes: 0, queueDlqWrites: 0, r2ClassA: 0, r2ClassB: 0 },
    container: { cpuMs: 0, wallMs: 0, memoryGibSeconds: 0, diskGbSeconds: 0, networkTxBytes: 0, peakRssBytes: 0, peakWorkBytes: 0 },
    r2StorageByteSeconds: 0
  };
  for (const row of rows || []) {
    const metric = String(row.metric || "");
    const dimension = String(row.dimension || "");
    const count = nonnegative(row.event_count);
    const bytes = nonnegative(row.byte_count);
    const sum = nonnegative(row.value_sum);
    const max = nonnegative(row.value_max);
    if (metric === "request" && dimension === "analyze") value.analyzeRequests += count;
    else if (metric === "request" && dimension === "download") value.downloadRequests += count;
    else if (metric === "result" && dimension === "success") value.processingSuccesses += count;
    else if (metric === "delivery" && dimension === "started") { value.fileDeliveryStarts += count; value.deliveredBytes += bytes; }
    else if (metric === "lifecycle" && dimension === "deleted") value.deleted += count;
    else if (metric === "lifecycle" && dimension === "expired") value.expired += count;
    else if (metric === "bytes" && dimension === "source") value.sourceBytes += bytes;
    else if (metric === "bytes" && dimension === "r2_stored") value.r2StoredBytes += bytes;
    else if (metric === "outcome" && dimension === "rejected") value.rejected += count;
    else if (metric === "outcome" && dimension === "failed") value.failed += count;
    else if (metric === "normalization" && Object.hasOwn(value.normalization, dimension)) value.normalization[dimension] += count;
    else if (metric === "security" && Object.hasOwn(value.security, dimension)) value.security[dimension] += count;
    else if (metric === "platform" && dimension === "worker_request") value.platform.workerRequests += count;
    else if (metric === "platform" && dimension === "queue_write") value.platform.queueWrites += count;
    else if (metric === "platform" && dimension === "queue_read") value.platform.queueReads += count;
    else if (metric === "platform" && dimension === "queue_delete") value.platform.queueDeletes += count;
    else if (metric === "platform" && dimension === "queue_dlq_write") value.platform.queueDlqWrites += count;
    else if (metric === "platform" && dimension === "r2_class_a") value.platform.r2ClassA += count;
    else if (metric === "platform" && dimension === "r2_class_b") value.platform.r2ClassB += count;
    else if (metric === "resource" && dimension === "container_cpu_ms") value.container.cpuMs += sum;
    else if (metric === "resource" && dimension === "container_wall_ms") value.container.wallMs += sum;
    else if (metric === "resource" && dimension === "container_memory_gib_seconds") value.container.memoryGibSeconds += sum;
    else if (metric === "resource" && dimension === "container_disk_gb_seconds") value.container.diskGbSeconds += sum;
    else if (metric === "resource" && dimension === "container_network_tx") value.container.networkTxBytes += bytes;
    else if (metric === "resource" && dimension === "container_peak_rss") value.container.peakRssBytes = Math.max(value.container.peakRssBytes, max);
    else if (metric === "resource" && dimension === "container_peak_work") value.container.peakWorkBytes = Math.max(value.container.peakWorkBytes, max);
    else if (metric === "resource" && dimension === "r2_storage_byte_seconds") value.r2StorageByteSeconds += sum;
  }
  return value;
}

export function estimateDownloaderCost(usage, pricing = DOWNLOADER_PRICING) {
  const queueOperations = usage.platform.queueWrites + usage.platform.queueReads + usage.platform.queueDeletes + usage.platform.queueDlqWrites;
  const cpuSeconds = usage.container.cpuMs / 1000;
  const storageGbMonth = usage.r2StorageByteSeconds / (1_000_000_000 * 30 * 24 * 60 * 60);
  const networkGb = usage.container.networkTxBytes / 1_000_000_000;
  const components = [
    component("Workers requests", usage.platform.workerRequests, pricing.workers.includedRequests, pricing.workers.requestPerMillion / 1_000_000, true),
    unavailableComponent("Workers CPU"),
    component("Containers CPU", cpuSeconds, pricing.containers.includedCpuSeconds, pricing.containers.cpuPerSecond, true),
    component("Containers memory", usage.container.memoryGibSeconds, pricing.containers.includedMemoryGibSeconds, pricing.containers.memoryPerGibSecond, false),
    component("Containers disk", usage.container.diskGbSeconds, pricing.containers.includedDiskGbSeconds, pricing.containers.diskPerGbSecond, false),
    component("Containers network", networkGb, pricing.containers.includedNetworkBytes / 1_000_000_000, pricing.containers.conservativeNetworkPerGb, false),
    component("Queues operations", queueOperations, pricing.queues.includedOperations, pricing.queues.operationPerMillion / 1_000_000, true),
    component("R2 storage", storageGbMonth, pricing.r2.includedStorageGbMonth, pricing.r2.storagePerGbMonth, false, 1),
    component("R2 Class A", usage.platform.r2ClassA, pricing.r2.includedClassA, pricing.r2.classAPerMillion / 1_000_000, true, 1_000_000),
    component("R2 Class B", usage.platform.r2ClassB, pricing.r2.includedClassB, pricing.r2.classBPerMillion / 1_000_000, true, 1_000_000),
    unavailableComponent("D1 rows read"),
    unavailableComponent("D1 rows written"),
    unavailableComponent("D1 storage")
  ];
  const estimatedAdditionalUsd = components.reduce((total, item) => total + (item.estimatedAdditionalUsd || 0), 0);
  return {
    label: "Downloader推定追加料金",
    currency: pricing.currency,
    pricingAsOf: pricing.asOf,
    estimatedAdditionalUsd,
    queueOperations,
    r2StorageGbMonth: storageGbMonth,
    components,
    complete: false,
    notes: [
      "Downloader内部で計測できた利用量だけを、Downloader単独で無料・付帯枠を利用した場合として概算しています。",
      "Workers CPU、D1の正確な行read/write、失敗したContainer処理、Containerの実際の起動待機時間は含みません。",
      "Containers memory/disk/networkは成功ジョブの観測値を使う参考値です。正式な請求額はCloudflare Billingを確認してください。",
      "Workers Paidの月額基本料金5 USDはDownloader専用料金ではないため含めていません。"
    ]
  };
}

function component(name, usage, included, rate, measured, billingUnit = 0) {
  const numericUsage = nonnegative(usage);
  const excess = Math.max(0, numericUsage - included);
  const billableUsage = billingUnit > 0 && excess > 0 ? Math.ceil(excess / billingUnit) * billingUnit : excess;
  return {
    name,
    usage: numericUsage,
    included,
    unitRateUsd: rate,
    measured,
    available: true,
    estimatedAdditionalUsd: billableUsage * rate
  };
}

function unavailableComponent(name) {
  return { name, usage: null, included: null, unitRateUsd: null, measured: false, available: false, estimatedAdditionalUsd: null };
}

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
