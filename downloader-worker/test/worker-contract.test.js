import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const client = await readFile(new URL("../public/downloader.js", import.meta.url), "utf8");
const resolver = await readFile(new URL("../container/resolver.py", import.meta.url), "utf8");
const imageShareAdapter = await readFile(new URL("../container/adapters/image_share.py", import.meta.url), "utf8");
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migration = await readFile(new URL("../migrations/0001_downloader_foundation.sql", import.meta.url), "utf8");
const usageMigration = await readFile(new URL("../migrations/0002_downloader_usage_stats.sql", import.meta.url), "utf8");
const scanner = await readFile(new URL("../container/scanner.py", import.meta.url), "utf8");
const clamd = await readFile(new URL("../container/clamd.conf", import.meta.url), "utf8");
const server = await readFile(new URL("../container/server.py", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../container/media_pipeline.py", import.meta.url), "utf8");
const entrypoint = await readFile(new URL("../container/entrypoint.sh", import.meta.url), "utf8");
const containerAttributes = await readFile(new URL("../container/.gitattributes", import.meta.url), "utf8");
const containerIgnore = await readFile(new URL("../container/.dockerignore", import.meta.url), "utf8");
const yaraRules = await readFile(new URL("../container/yara-rules/sources/tlain_downloader.yar", import.meta.url), "utf8");

test("二段階解析と明示的な権利確認を分離する", () => {
  assert.match(worker, /\/api\/analyze/);
  assert.match(worker, /rightsConfirmed !== true/);
  assert.match(worker, /status = 'analyzed'/);
  assert.match(worker, /status = 'queued'/);
  assert.match(client, /分析|解析/);
  assert.match(html, /保存する権利があります/);
  assert.match(worker, /type: "analyze"/);
  assert.match(client, /status === "analyzing"/);
});

test("URL全文をD1と監査へ保存しない", () => {
  assert.doesNotMatch(migration, /source_url|full_url|query_string/i);
  assert.match(migration, /url_hash/);
  assert.match(worker, /sourceCiphertext/);
  assert.doesNotMatch(worker, /details[^\n]*sourceUrl/);
  assert.match(worker, /urlFingerprint/);
  assert.doesNotMatch(worker, /sha256Text\(sourceUrl\.href\)/);
  assert.match(worker, /source_path_hint, url_hash[\s\S]*\.bind\([^\n]*null, hash\)/);
});

test("Private R2・Queue・Container・Securityを独立bindingにする", () => {
  assert.equal(config.r2_buckets[0].bucket_name, "t-room-downloader-temp");
  assert.equal(config.queues.producers[0].queue, "t-room-downloader-jobs");
  assert.equal(config.services[0].service, "t-room-security");
  assert.equal(config.containers[0].class_name, "DownloaderContainer");
  assert.equal(config.assets.run_worker_first, true);
});

test("未公開ページを検索・共有対象から除外する", () => {
  assert.match(html, /noindex,nofollow,noarchive,nosnippet,noimageindex/);
  assert.doesNotMatch(html, /property=["']og:/i);
  assert.match(worker, /X-Robots-Tag/);
  assert.match(worker, /frame-ancestors 'none'/);
});

test("YouTubeは解析と本体取得を分離して規約上拒否する", () => {
  assert.match(worker, /isPolicyRestrictedHost/);
  assert.match(worker, /isPolicyRestrictedAnalysis\(analysis\)/);
  assert.match(worker, /isPolicyRestrictedAnalysis\(parseJson\(row\.analysis_json/);
  assert.match(worker, /status: 451|new HttpError\(451/);
  assert.match(worker, /YouTubeの利用規約/);
  assert.match(resolver, /policy_restricted[\s\S]*item\["downloadable"\] = False/);
  assert.match(html, /自分が投稿した動画、または保存する権利を持つ動画のみ利用可能/);
  assert.match(worker, /youtubeRightsConfirmed !== true/);
});

test("ユーザー分離と一回限りhandoffを既存Security境界へ委譲する", () => {
  assert.match(worker, /redeemHandoff\(String\(body\.handoffToken \|\| ""\), "downloader"\)/);
  assert.match(worker, /validatePasskeySession/);
  assert.match(worker, /WHERE identity_id = \?/);
  assert.doesNotMatch(worker, /password_login|login_password/);
});

test("R2確定後に30分削除をQueueへ予約しCronも補完する", () => {
  assert.match(worker, /delaySeconds/);
  assert.match(worker, /DOWNLOAD_TTL_SECONDS/);
  assert.match(worker, /cleanupExpiredJobs/);
  assert.match(worker, /env\.DOWNLOADS\.delete/);
  assert.match(worker, /processing_token = \?/);
  assert.match(worker, /processing_lease_expires_at/);
  assert.match(worker, /cleanupOrphanObjects/);
  assert.match(worker, /row\.status === "queued"[\s\S]*env\.JOBS\.send/, "Queue送信失敗・応答消失後は同じjobを安全に再配送できる");
  assert.match(worker, /normalization_mode = \?/);
});

test("Queue失敗は4回目でD1をfailedにしてackせずDLQへ委譲する", () => {
  assert.equal(config.queues.consumers[0].max_retries, 3);
  assert.equal(config.queues.consumers[0].dead_letter_queue, "t-room-downloader-jobs-dlq");
  assert.match(worker, /isFinalQueueAttempt\(message\.attempts, QUEUE_MAX_RETRIES\)/);
  assert.match(worker, /terminalAttempt[\s\S]*markDownloadFailed/);
  assert.match(worker, /Do not acknowledge failures[\s\S]*message\.retry/);
  const queueFailure = worker.slice(worker.indexOf("} catch (error) {", worker.indexOf("export async function handleQueueBatch")), worker.indexOf("\n    }\n  }\n}", worker.indexOf("export async function handleQueueBatch")));
  assert.doesNotMatch(queueFailure, /message\.ack\(\)/);
});

test("ContainerはClamAVとYARAをfail-closedで確認してからffprobeへ渡す", () => {
  assert.match(scanner, /CLAMAV_MAX_DEFINITION_AGE_SECONDS/);
  assert.match(scanner, /malware_definitions_missing/);
  assert.match(scanner, /malware_definitions_stale/);
  assert.match(scanner, /REQUIRED_CLAMAV_DATABASES = \("main", "daily", "bytecode"\)/);
  assert.match(clamd, /^AlertExceedsMax yes$/m);
  assert.match(clamd, /^MaxFileSize 2G$/m);
  assert.match(clamd, /^MaxScanSize 2G$/m);
  assert.match(clamd, /^PCREMaxFileSize 2G$/m);
  assert.match(scanner, /_scan_large_file_windows/);
  assert.match(scanner, /CLAMD_WINDOW_OVERLAP_BYTES/);
  assert.match(scanner, /_scan_yara\(path,/);
  assert.match(scanner, /yara_rules_status/);
  assert.match(scanner, /yara_detected/);
  assert.match(scanner, /yara_scan_timeout/);
  assert.match(yaraRules, /TLAIN_YARA_SAFE_TEST_MARKER/);
  assert.ok(scanner.indexOf("_scan_malware(path,") < scanner.indexOf("probe = probe_file(path,"));
  assert.ok(scanner.indexOf("_scan_yara(path,") < scanner.indexOf("probe = probe_file(path,"));
  assert.match(server, /signal\.SIGTERM/);
  assert.match(server, /DRAINING\.set\(\)/);
  assert.equal(config.containers[0].rollout_active_grace_period, 900);
  assert.equal(config.containers[0].image_vars.CLAMAV_DEFINITION_REFRESH, "2026-W36");
  assert.match(worker, /enableInternet = false/);
  assert.match(worker, /pingEndpoint = "localhost\/health"/);
  assert.match(worker, /DownloaderContainer\.outbound = async/);
  assert.match(worker, /DownloaderContainer\.outboundByHost/);
  assert.match(worker, /pathname === "\/download"/);
  assert.match(worker, /renewActivityTimeout\(\)/);
  assert.match(worker, /setTimeout\(renewActivity, 60_000\)/);
  assert.match(worker, /clearTimeout\(activityTimer\)/);
  assert.match(worker, /async release\(\)[\s\S]*await this\.stop\(\)/);
  assert.match(worker, /finally \{[\s\S]*await releaseContainer\(container\)/);
});

test("外向き通信はallowlist headerと制限POSTだけを利用する", () => {
  assert.match(worker, /OUTBOUND_REQUEST_HEADERS/);
  assert.match(worker, /isAllowedExtractorPost/);
  assert.match(worker, /X-Real-IP/);
  assert.match(worker, /setAllowedHosts/);
  assert.match(worker, /configureContainerEgress/);
  assert.doesNotMatch(worker, /const headers = new Headers\(request\.headers\)/);
  assert.equal(config.observability.redact_query_string, true);
  assert.doesNotMatch(resolver, /T-lain-Downloader\/1\.0/);
});

test("解析時に確定した暗号化routeだけで実取得する", () => {
  assert.match(resolver, /Execute the exact SSRF-validated route selected during analysis/);
  assert.match(resolver, /"_downloadRoute"/);
  assert.match(worker, /_sealedRoutes/);
  assert.match(worker, /capability\.sourceHash !== row\.url_hash/);
  assert.match(worker, /capability\.jobId !== jobId/);
  assert.match(worker, /capability\.mediaId !== String\(message\.mediaId/);
  const downloadHandler = server.slice(server.indexOf("def _download(self, body):"), server.indexOf("def _json_body", server.indexOf("def _download(self, body):")));
  assert.doesNotMatch(downloadHandler, /body\.get\("url"\)/);
});

test("Container処理前にhealth本文とHTTP statusを明示確認する", () => {
  assert.match(worker, /requireHealthyContainer\(container\)/);
  assert.match(worker, /response\.ok && health\.ok === true/);
  assert.match(worker, /health\.draining === false/);
  assert.match(worker, /health\.clamav\?\.healthy === true/);
  assert.match(worker, /health\.clamav\?\.daemonReady === true/);
  assert.match(worker, /health\.yara\?\.healthy === true/);
  assert.match(worker, /health\.yara\?\.verified === true/);
  assert.match(worker, /throw new Error\("container_unhealthy"\)/);
  const timeout = worker.match(/const CONTAINER_HEALTH_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(timeout, "Container health timeout must be explicit");
  const timeoutMs = Number(timeout[1].replaceAll("_", ""));
  assert.ok(timeoutMs >= 60_000 && timeoutMs <= 120_000, "health timeout must allow a ClamAV cold start without becoming unbounded");
});

test("全処理は絶対deadlineを共有しPASS_THROUGHだけ再scanしない", () => {
  assert.match(server, /deadline = JobDeadline\(timeout\)/);
  assert.match(server, /download\([\s\S]*deadline=deadline/);
  assert.match(server, /inspect_file\([\s\S]*deadline=deadline/);
  assert.match(server, /normalize_video\([\s\S]*deadline=deadline/);
  assert.match(server, /_upload_to_r2\([\s\S]*deadline=deadline[\s\S]*source_bytes=source_bytes/);
  assert.match(server, /plan\.kind != PlanKind\.PASS_THROUGH/);
  assert.match(server, /"metrics": metrics/);
  assert.match(worker, /downloader_container_metrics/);
  assert.match(worker, /QUEUE_MAX_WALL_MS = 15 \* 60_000/);
  assert.match(worker, /CONTAINER_HEALTH_TIMEOUT_MS \+ 720_000 \+ CONTAINER_RESPONSE_GRACE_MS \+ QUEUE_FINALIZATION_RESERVE_MS > QUEUE_MAX_WALL_MS/);
  assert.match(worker, /leaseExpiresAt = nowSeconds\(\) \+ Math\.ceil\(CONTAINER_HEALTH_TIMEOUT_MS \/ 1000\)/);
  assert.match(pipeline, /source_probe=initial_scan\.probe|source_probe: dict \| None/);
  assert.match(scanner, /start_clamav_daemon\(deadline=deadline, reserve_seconds=reserve_seconds\)/);
  assert.match(scanner, /deadline\.ensure\(reserve_seconds=reserve_seconds\)/);
});

test("親アカウント専用統計はサーバー認可し秘匿情報を日次集計へ保存しない", () => {
  assert.match(worker, /requireParentUsageSession\(session\)/);
  assert.match(worker, /isParentUsageSession\(session, SESSION_ROLE\)/);
  assert.match(worker, /identityId: session\.identityId/);
  assert.match(usageMigration, /CREATE TABLE downloader_usage_daily/);
  assert.match(usageMigration, /CREATE TABLE downloader_file_delivery_attempts/);
  assert.doesNotMatch(usageMigration, /source_url|query_string|filename|authorization|cookie/i);
  assert.match(worker, /INSERT OR IGNORE INTO downloader_file_delivery_attempts/);
  assert.match(worker, /delivery-attempt-v1/);
  assert.doesNotMatch(worker, /\.bind\(row\.id, supplied/);
  assert.match(worker, /\/api\/admin\/usage/);
});

test("実probeのplanで特殊H.264を含む映像再エンコード予算を再判定する", () => {
  assert.match(pipeline, /enforce_video_transcode_budget\(source_probe, plan\)/);
  assert.match(pipeline, /plan\.video_codec == "copy"/);
  assert.match(pipeline, /VIDEO_TRANSCODE_BUDGET_EQUIVALENT_1080P30_SECONDS = 240\.0/);
});

test("Chromiumはjobごとの一時profileを使い終了後に残さない", () => {
  assert.match(resolver, /TemporaryDirectory\(prefix="chromium-", dir="\/work"\)/);
  assert.match(resolver, /--user-data-dir=/);
  assert.match(resolver, /--disable-features=Crashpad/);
});

test("HTTPS interception CAを非root起動時に信頼する", () => {
  assert.match(entrypoint, /cloudflare-containers-ca\.crt/);
  assert.match(entrypoint, /base-ca-certificates\.crt/);
  assert.match(entrypoint, /SSL_CERT_FILE/);
  assert.match(entrypoint, /REQUESTS_CA_BUNDLE/);
  assert.match(resolver, /_network_subprocess_environment/);
  assert.match(resolver, /"--compat-options", "no-certifi"/);
  assert.match(resolver, /CURL_CA_BUNDLE/);
  assert.doesNotMatch(resolver, /env\.update\(\{"SSL_CERT_FILE": ca, "REQUESTS_CA_BUNDLE": ca\}\)/);
});

test("image-shareは限定adapterで候補を解決しWorker再検証後に動的allowlistする", () => {
  assert.match(worker, /IMAGE_SHARE_SOURCE_HOST = "cdn\.image-share\.cc"/);
  assert.match(worker, /IMAGE_SHARE_API_HOST = "rwzugqnp\.fun800\.click"/);
  assert.match(worker, /resolveAnalysisSource\(container, sourceUrl/);
  assert.match(worker, /normalizeSourceUrl\(result\.url\)/);
  assert.match(worker, /configureContainerEgress\(container, sourceUrl, resolved\.egressHosts\)/);
  assert.match(server, /self\.path == "\/resolve-adapter"/);
  assert.match(imageShareAdapter, /source_hostname = "cdn\.image-share\.cc"/);
  assert.match(imageShareAdapter, /for name in \("fileUrl", "originUrl"\)/);
  assert.doesNotMatch(imageShareAdapter, /\.click\s*\(|\b(?:chromium|selenium|playwright)\b/i);
});

test("yt-dlp失敗はstderrを保存せず固定コードへ分類する", () => {
  for (const code of ["download_network_failed", "download_tls_failed", "format_unavailable", "manifest_invalid", "download_timeout"]) {
    assert.match(resolver, new RegExp(code));
  }
  assert.match(resolver, /_classify_ytdlp_failure\(result\.stderr\) or "download_failed"/);
  assert.doesNotMatch(server, /print\([^\n]*stderr/);
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*stderr/);
});

test("Linux ContainerのentrypointはWindows checkoutでもLFを維持する", () => {
  assert.equal(entrypoint.includes("\r"), false, "CRLF shebang makes the Linux entrypoint unexecutable");
  assert.match(containerAttributes, /^\*\.sh text eol=lf$/m);
  assert.match(containerIgnore, /^\*\*\/__pycache__\/$/m);
  assert.match(containerIgnore, /^\*\.py\[cod\]$/m);
});

test("外部ツールはshellを介さず固定argvと制限protocolで実行する", async () => {
  for (const source of [resolver, pipeline]) {
    assert.match(source, /subprocess\.run\(\s*(?:command|\[)/);
    assert.doesNotMatch(source, /shell\s*=\s*True|(?:sh|bash)\s+-c/);
  }
  assert.match(resolver, /ffmpeg_i:-protocol_whitelist http,https,tcp,tls/);
  assert.match(pipeline, /"-protocol_whitelist", "file,pipe"/);
});
