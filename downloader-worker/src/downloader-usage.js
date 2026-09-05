export const PRIMARY_ADMIN_IDENTITY_ID = "primary-admin";

export const DOWNLOADER_PRICING = Object.freeze({
  currency: "USD",
  asOf: "2026-09-05",
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
  else if (code.includes("download_tls_failed")) category = "tls_failed";
  else if (code.includes("download_network_failed")) category = "network_failed";
  else if (/(mime_mismatch|extension_mismatch|unsupported_mime|executable_content|blocked_extension|suspicious_double_extension|magic_failed)/.test(code)) category = "file_type_mismatch";
  else if (/(ffprobe_|invalid_media_stream|unsafe_embedded_stream|normalized_|normalization_|manifest_invalid|format_unavailable)/.test(code)) category = "malformed_media";
  else if (code.includes("scanner_rejected") || code.startsWith("scan_")) category = "scanner_rejected";
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
    container: { cpuMs: 0, wallMs: 0, memoryGibSeconds: 0, diskGbSeconds: 0, networkTxBytes: 0, peakRssBytes: 0, peakWorkBytes: 0, cpuSamples: 0, wallSamples: 0, provisional: 0, finalized: 0, legacyMemoryGibSeconds: 0, legacyDiskGbSeconds: 0 },
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
    else if (metric === "resource" && dimension === "container_cpu_ms") { value.container.cpuMs += sum; value.container.cpuSamples += count; }
    else if (metric === "resource" && dimension === "container_wall_ms") value.container.wallMs += sum;
    else if (metric === "resource" && dimension === "container_memory_gib_seconds") value.container.legacyMemoryGibSeconds += sum;
    else if (metric === "resource" && dimension === "container_disk_gb_seconds") value.container.legacyDiskGbSeconds += sum;
    else if (metric === "resource" && dimension === "container_observed_memory_gib_seconds") { value.container.memoryGibSeconds += sum; value.container.wallSamples += count; }
    else if (metric === "resource" && dimension === "container_observed_disk_gb_seconds") value.container.diskGbSeconds += sum;
    else if (metric === "measurement" && dimension === "container_provisional") value.container.provisional += count;
    else if (metric === "measurement" && dimension === "container_finalized") value.container.finalized += count;
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
    (usage.container.cpuSamples > 0 || cpuSeconds > 0) ? component("Containers CPU", cpuSeconds, pricing.containers.includedCpuSeconds, pricing.containers.cpuPerSecond, false) : unavailableComponent("Containers CPU"),
    usage.container.wallSamples > 0 ? component("Containers memory", usage.container.memoryGibSeconds, pricing.containers.includedMemoryGibSeconds, pricing.containers.memoryPerGibSecond, false) : unavailableComponent("Containers memory"),
    usage.container.wallSamples > 0 ? component("Containers disk", usage.container.diskGbSeconds, pricing.containers.includedDiskGbSeconds, pricing.containers.diskPerGbSecond, false) : unavailableComponent("Containers disk"),
    component("Containers network", networkGb, pricing.containers.includedNetworkBytes / 1_000_000_000, pricing.containers.conservativeNetworkPerGb, false),
    component("Queues operations", queueOperations, pricing.queues.includedOperations, pricing.queues.operationPerMillion / 1_000_000, true),
    component("R2 storage", storageGbMonth, pricing.r2.includedStorageGbMonth, pricing.r2.storagePerGbMonth, false, 1),
    component("R2 Class A", usage.platform.r2ClassA, pricing.r2.includedClassA, pricing.r2.classAPerMillion / 1_000_000, true, 1_000_000),
    component("R2 Class B", usage.platform.r2ClassB, pricing.r2.includedClassB, pricing.r2.classBPerMillion / 1_000_000, true, 1_000_000),
    unavailableComponent("D1 rows read"),
    unavailableComponent("D1 rows written"),
    unavailableComponent("D1 storage"),
    unavailableComponent("Durable Objects"),
    unavailableComponent("Logs")
  ];
  const estimatedAdditionalUsd = components.reduce((total, item) => total + (item.estimatedAdditionalUsd || 0), 0);
  return {
    label: "Downloader対象分の追加料金試算",
    currency: pricing.currency,
    pricingAsOf: pricing.asOf,
    estimatedAdditionalUsd,
    queueOperations,
    r2StorageGbMonth: storageGbMonth,
    components,
    complete: false,
    notes: [
      "表示額は対象範囲だけの小計です。無料・追加課金なし・請求上限を示しません。不明な利用量は含めていません。",
      "月間付帯枠をDownloaderだけで利用できると仮定した試算です。枠はアカウント内の他サービスと共有され、他の利用分を差し引いていません。",
      "URL解析、Container起動／health待ち、停止、失敗・再試行の使用量、Workers CPU、D1のread/write・保存、Durable Objects、Logsは集計対象外です。release RPC完了もCloudflareの課金終了時刻ではありません。",
      "memory/diskは今回の変更以後の成功処理のwall timeに割当量6 GiB／12 GBを掛けた参考値です。固定120秒は加算せず、旧120秒込みの履歴は保存したまま料金試算から除外しています。未計測の稼働時間は推測で補完しません。",
      "CPUは成功処理区間の値です。旧方式・fallbackはプロセスと回収済み子プロセスのみで常駐clamdを含まず、cgroup v2方式と計測範囲が異なります。過去値は補完していません。",
      `変更以後の当月計測: 最終応答受信 ${usage.container.finalized}件、最終応答未受信 ${usage.container.provisional}件。未受信時は保存前までの暫定値です。最終応答にも個別の欠測があり得ます。`,
      "Containers networkは成功時のR2保存容量を使う参考値です。正式な請求額はCloudflare Billingを確認してください。",
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
