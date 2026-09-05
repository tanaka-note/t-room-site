import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { sessionCookieValue, sessionPolicyForAuthMethod } from "../../assets/session-policy.mjs";
import {
  DomainError,
  DOWNLOAD_TTL_SECONDS,
  MAX_FILE_BYTES,
  MAX_SPACE_BYTES,
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
} from "./downloader-domain.js";
import {
  aggregateUsageRows,
  classifyUsageError,
  estimateDownloaderCost,
  isParentUsageSession,
  jstUsageDate,
  jstUsageMonth
} from "./downloader-usage.js";

export { ContainerProxy };

const BASE_PATH = "/downloader";
const SESSION_COOKIE = "troom_downloader_session";
const SESSION_ROLE = "owner";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PRIVACY_EGRESS_USER_AGENT = "Mozilla/5.0";
const PRIVACY_EGRESS_IP = "2a06:98c0:3600::103";
const OUTBOUND_REQUEST_HEADERS = Object.freeze(["Accept", "Accept-Encoding", "Accept-Language", "Range", "If-Range"]);
const YOUTUBE_ANALYSIS_HOSTS = Object.freeze([
  "youtube.com", "*.youtube.com", "youtu.be", "youtube-nocookie.com", "*.youtube-nocookie.com",
  "youtubei.googleapis.com", "jnn-pa.googleapis.com", "i.ytimg.com", "googlevideo.com", "*.googlevideo.com"
]);
const IMAGE_SHARE_SOURCE_HOST = "cdn.image-share.cc";
const IMAGE_SHARE_API_HOST = "rwzugqnp.fun800.click";
const PRIVATE_DESTINATIONS = Object.freeze([
  "localhost", "*.localhost", "metadata.google.internal", "metadata.aws.internal", "instance-data.ec2.internal",
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32"
]);
// A cold Container must start ClamAV before /health can become ready. Keep this
// below the request processing windows, but allow enough time for a real cold
// start instead of spending Queue retries before any media work begins.
const CONTAINER_HEALTH_TIMEOUT_MS = 90_000;
const CONTAINER_RESPONSE_GRACE_MS = 20_000;
const QUEUE_FINALIZATION_RESERVE_MS = 60_000;
const QUEUE_MAX_WALL_MS = 15 * 60_000;
const CONTAINER_PROGRESS_STAGES = new Set(["downloading", "validating", "processing", "scanning", "saving", "finalizing"]);
if (CONTAINER_HEALTH_TIMEOUT_MS + 720_000 + CONTAINER_RESPONSE_GRACE_MS + QUEUE_FINALIZATION_RESERVE_MS > QUEUE_MAX_WALL_MS) {
  throw new Error("downloader_queue_deadline_configuration_invalid");
}

export class DownloaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = false;
  interceptHttps = true;
  deniedHosts = [...PRIVATE_DESTINATIONS];
  pingEndpoint = "localhost/health";

  async fetch(request) {
    const longRunning = new URL(request.url).pathname === "/download";
    let activityTimer = null;
    const renewActivity = () => {
      this.renewActivityTimeout();
      if (longRunning) activityTimer = setTimeout(renewActivity, 60_000);
    };
    renewActivity();
    try {
      return await this.containerFetch(request);
    } finally {
      if (activityTimer !== null) clearTimeout(activityTimer);
    }
  }

  async release() {
    await this.stop();
  }
}

DownloaderContainer.outboundByHost = {
  "r2.tlain.internal": async (request, env, ctx) => handleContainerInternalRequest(request, env, ctx)
};

DownloaderContainer.outbound = async (request) => {
  try {
    const url = normalizeSourceUrl(request.url);
    if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response("Method Not Allowed", { status: 405 });
    if (request.method === "POST" && !isAllowedExtractorPost(url)) return new Response("Method Not Allowed", { status: 405 });
    const headers = new Headers({ "User-Agent": PRIVACY_EGRESS_USER_AGENT, "X-Real-IP": PRIVACY_EGRESS_IP });
    for (const name of OUTBOUND_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value.slice(0, 512));
    }
    if (request.method === "POST") {
      headers.set("Content-Type", "application/json");
      headers.set("Origin", "https://www.youtube.com");
      copyYoutubeExtractorHeader(request.headers, headers, "X-Youtube-Client-Name", /^\d{1,4}$/, 4);
      copyYoutubeExtractorHeader(request.headers, headers, "X-Youtube-Client-Version", /^[A-Za-z0-9._-]{1,40}$/, 40);
      copyYoutubeExtractorHeader(request.headers, headers, "X-Goog-Visitor-Id", /^[A-Za-z0-9_%=-]{1,2048}$/, 2048);
    }
    return fetch(new Request(url, { method: request.method, headers, body: request.method === "POST" ? request.body : null, redirect: "manual" }));
  } catch (error) {
    return new Response(error instanceof DomainError ? error.message : "Blocked", { status: error instanceof DomainError ? error.status : 403 });
  }
};

export default class DownloaderWorker extends WorkerEntrypoint {
  async fetch(request) {
    try {
      return await handleRequest(request, this.env, this.ctx);
    } catch (error) {
      const status = Number(error?.status || 500);
      if (status >= 500) console.error(JSON.stringify({ event: "downloader_request_failed", error: safeErrorName(error) }));
      return json({ error: status >= 500 ? "Downloaderで処理を完了できませんでした。" : error.message, code: error?.code || "request_failed" }, status);
    }
  }

  async queue(batch) {
    await handleQueueBatch(batch, this.env);
  }

  async scheduled() {
    await safeRecordUsageItems(this.env, "system", [{ metric: "platform", dimension: "worker_request", count: 1 }]);
    await cleanupExpiredJobs(this.env);
  }
}

export async function handleQueueBatch(batch, env) {
  await safeRecordUsageItems(env, "system", [{ metric: "platform", dimension: "worker_request", count: 1 }]);
  for (const message of batch.messages) {
    const messageIdentityId = safeUsageIdentityId(message.body?.identityId);
    await safeRecordUsageItems(env, messageIdentityId, [{ metric: "platform", dimension: "queue_read", count: 1 }]);
    try {
      const body = message.body || {};
      if (body.type === "analyze") await processAnalyzeMessage(env, body);
      else if (body.type === "download") await processDownloadMessage(env, body);
      else if (body.type === "delete") await deleteJobObject(env, String(body.jobId || ""), "expired");
      message.ack();
      await safeRecordUsageItems(env, messageIdentityId, [{ metric: "platform", dimension: "queue_delete", count: 1 }]);
    } catch (error) {
      const terminalAttempt = isFinalQueueAttempt(message.attempts, QUEUE_MAX_RETRIES);
      console.error(JSON.stringify({
        event: "downloader_queue_failed",
        jobId: safeQueueJobId(message.body?.jobId),
        error: safeErrorName(error),
        attempts: message.attempts,
        terminalAttempt
      }));
      if (terminalAttempt && ["analyze", "download"].includes(message.body?.type)) {
        try {
          if (message.body?.type === "analyze") await markAnalysisFailed(env, message.body, error);
          else await markDownloadFailed(env, message.body, error);
        } catch (markError) {
          console.error(JSON.stringify({ event: "downloader_queue_failure_status_update_failed", error: safeErrorName(markError) }));
        }
      }
      if (terminalAttempt) {
        await safeRecordUsageItems(env, messageIdentityId, [{ metric: "platform", dimension: "queue_dlq_write", count: 1 }]);
      }
      // Do not acknowledge failures. On the fourth delivery (initial attempt plus
      // max_retries=3), retry() lets Cloudflare move the message to the configured DLQ.
      if (terminalAttempt) message.retry();
      else message.retry({ delaySeconds: queueRetryDelaySeconds(message.attempts) });
    }
  }
}

export class SecurityIntegration extends WorkerEntrypoint {
  async getSessionRuntimeState() {
    return {
      sessionVersion: String(this.env.SESSION_VERSION || "1"),
      passkeyEnabled: String(this.env.PASSKEY_ENABLED || "false") === "true"
    };
  }

  async listLinkTargets() {
    return {
      service: "downloader",
      displayName: "T-lain Downloader",
      targets: [{
        accountId: "owner",
        displayLabel: "T-lain Downloader 管理者",
        role: "owner",
        roleLabel: "管理者",
        privileged: true,
        exclusive: false,
        shared: false,
        rootFolderId: null
      }]
    };
  }

  async describeAccount(input) {
    return String(input?.accountId || "") === "owner"
      ? { valid: true, ...(await this.listLinkTargets()).targets[0] }
      : { valid: false };
  }
}

async function handleRequest(request, env, context) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(BASE_PATH)) throw new HttpError(404, "指定された情報が見つかりません。");
  const path = url.pathname.slice(BASE_PATH.length) || "/";
  if (!path.startsWith("/api/")) return serveAsset(request, env, url, path);

  if (path === "/api/passkey/handoff" && request.method === "POST") {
    requireMutation(request, url);
    return completePasskeyHandoff(request, env, url);
  }

  const session = await requireSession(request, env);
  scheduleUsage(context, safeRecordUsageItems(env, session.identityId, [{ metric: "platform", dimension: "worker_request", count: 1 }]));
  if (path === "/api/session" && request.method === "GET") {
    scheduleAudit(context, audit(env, request, session, "session_resume", "success"));
    return json({ authenticated: true, isParent: isParentUsageSession(session, SESSION_ROLE), user: { displayName: session.displayName, role: SESSION_ROLE } });
  }
  if (path === "/api/logout" && request.method === "POST") {
    requireMutation(request, url);
    scheduleAudit(context, audit(env, request, session, "logout", "success"));
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(url.protocol === "https:") });
  }
  if (path === "/api/jobs" && request.method === "GET") return listJobs(env, session);
  if (path === "/api/admin/usage" && request.method === "GET") {
    requireParentUsageSession(session);
    return usageDashboard(env);
  }
  if (path === "/api/analyze" && request.method === "POST") {
    requireMutation(request, url);
    try {
      return await analyzeSource(request, env, session);
    } catch (error) {
      await recordRequestFailure(env, session.identityId, error);
      throw error;
    }
  }

  const jobMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/);
  if (jobMatch && request.method === "GET") return getJob(env, session, jobMatch[1]);
  const downloadMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/download$/);
  if (downloadMatch && request.method === "POST") {
    requireMutation(request, url);
    try {
      return await requestDownload(request, env, session, downloadMatch[1]);
    } catch (error) {
      await recordRequestFailure(env, session.identityId, error);
      throw error;
    }
  }
  const fileMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/file$/);
  if (fileMatch && request.method === "GET") return serveDownload(request, env, session, fileMatch[1]);
  const deleteMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/delete$/);
  if (deleteMatch && request.method === "POST") {
    requireMutation(request, url);
    await deleteOwnedJob(env, session, deleteMatch[1]);
    return json({ ok: true });
  }
  throw new HttpError(404, "指定された情報が見つかりません。");
}

async function completePasskeyHandoff(request, env, url) {
  if (!env.SECURITY) throw new HttpError(503, "認証基盤へ接続できません。");
  if (!passkeysEnabled(env)) throw new HttpError(503, "パスキー機能は一時停止中です。");
  const body = await readJson(request, 4096);
  const handoff = await env.SECURITY.redeemHandoff(String(body.handoffToken || ""), "downloader");
  if (!handoff || handoff.serviceAccountId !== "owner") {
    throw new HttpError(401, "Downloaderを利用できるパスキーを確認できませんでした。");
  }
  const policy = sessionPolicyForAuthMethod(env, "passkey");
  const payload = {
    identityId: handoff.identityId,
    displayName: handoff.identityDisplayName || "第一管理者",
    credentialId: handoff.credentialId,
    serviceLinkId: handoff.serviceLinkId,
    serviceAccountId: handoff.serviceAccountId,
    passkeySessionEpoch: handoff.sessionEpoch,
    authMethod: "passkey",
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    sessionVersion: String(env.SESSION_VERSION || "1"),
    expiresAt: nowSeconds() + policy.ttlSeconds
  };
  const token = await signSession(payload, env);
  await audit(env, request, payload, "passkey_login_success", "success");
  await safeRecordUsageItems(env, payload.identityId, [{ metric: "platform", dimension: "worker_request", count: 1 }]);
  return json({ authenticated: true, displayName: payload.displayName, isParent: isParentUsageSession(payload, SESSION_ROLE) }, 200, {
    "Set-Cookie": sessionCookieValue(SESSION_COOKIE, token, BASE_PATH, policy, url.protocol === "https:")
  });
}

async function requireSession(request, env) {
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  const session = await verifySession(token, env);
  if (!session || !passkeysEnabled(env)) throw new HttpError(401, "パスキーでログインしてください。");
  const valid = await env.SECURITY?.validatePasskeySession({
    service: "downloader",
    identityId: session.identityId,
    credentialId: session.credentialId,
    serviceLinkId: session.serviceLinkId,
    serviceAccountId: session.serviceAccountId,
    sessionEpoch: session.passkeySessionEpoch
  });
  if (valid?.valid !== true) throw new HttpError(401, "パスキーセッションの有効期限が切れました。もう一度ログインしてください。");
  return session;
}

async function analyzeSource(request, env, session) {
  ensureContainerConfigured(env);
  ensureQueueConfigured(env);
  const body = await readJson(request, 8192);
  const sourceUrl = normalizeSourceUrl(body.url);
  if (isPolicyRestrictedHost(sourceUrl.hostname) && body.youtubeRightsConfirmed !== true) {
    throw new HttpError(400, "YouTubeは、ご自身が投稿した動画または保存する権利を持つ動画であることを確認してください。", "youtube_rights_confirmation_required");
  }
  const clientRequestId = normalizeClientRequestId(body.clientRequestId);
  if (!clientRequestId) throw new HttpError(400, "解析リクエストを確認してください。");
  await enforceRateLimit(env, session.identityId, sourceUrl.hostname, "analyze", 30, 10);
  const hash = await urlFingerprint(sourceUrl.href, env);
  const existing = await env.DB.prepare("SELECT * FROM downloader_jobs WHERE identity_id = ? AND client_request_id = ?")
    .bind(session.identityId, clientRequestId).first();
  if (existing) {
    if (existing.url_hash !== hash) throw new HttpError(409, "同じリクエスト番号を別のURLへ使用できません。");
    return json({ job: publicJob(existing) });
  }

  const jobId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO downloader_jobs
      (id, identity_id, service_link_id, client_request_id, status, source_hostname, source_path_hint, url_hash)
      VALUES (?, ?, ?, ?, 'analyzing', ?, ?, ?)`)
      .bind(jobId, session.identityId, session.serviceLinkId, clientRequestId, sourceUrl.hostname, null, hash),
    rateEventStatement(env, session.identityId, sourceUrl.hostname, "analyze")
  ]);
  await audit(env, request, session, "downloader_analyze_requested", "success", auditSource(sourceUrl, hash, jobId));
  const encrypted = await encryptPrivatePayload({ url: sourceUrl.href }, env);
  try {
    await sendJobMessage(env, { type: "analyze", jobId, identityId: session.identityId, ...encrypted });
    return json({ job: publicJob(await ownedJob(env, session.identityId, jobId)) }, 202);
  } catch (error) {
    const failure = classifyUsageError(error);
    await env.DB.prepare(`UPDATE downloader_jobs SET status = 'failed', error_type = 'analyze_failed', error_reason = ?,
      failure_category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ? AND status = 'analyzing'`)
      .bind(userSafeError(error), failure.category, jobId, session.identityId).run();
    if (error && typeof error === "object") error.usageOutcomeRecorded = true;
    await audit(env, request, session, "downloader_analyze_failed", "failure", auditSource(sourceUrl, hash, jobId));
    throw error;
  }
}

async function processAnalyzeMessage(env, message) {
  ensureContainerConfigured(env);
  const jobId = String(message.jobId || "");
  const identityId = String(message.identityId || "");
  const row = await env.DB.prepare("SELECT * FROM downloader_jobs WHERE id = ? AND identity_id = ?")
    .bind(jobId, identityId).first();
  if (!row || row.status !== "analyzing") return;
  const analysisToken = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE downloader_jobs SET processing_token = ?, processing_lease_expires_at = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ? AND status = 'analyzing'
    AND (processing_token IS NULL OR processing_lease_expires_at IS NULL OR processing_lease_expires_at <= ?)`)
    .bind(analysisToken, nowSeconds() + 180, jobId, identityId, nowSeconds()).run();
  if (!claim.meta?.changes) return;
  let container = null;
  try {
    const payload = await decryptPrivatePayload(message, env);
    const sourceUrl = normalizeSourceUrl(payload.url);
    if (await urlFingerprint(sourceUrl.href, env) !== row.url_hash || sourceUrl.hostname !== row.source_hostname) {
      throw new Error("analysis_capability_mismatch");
    }
    container = getContainer(env.DOWNLOADER_CONTAINER, `analysis-${jobId}`);
    await requireHealthyContainer(container);
    const resolved = await resolveAnalysisSource(container, sourceUrl, maxFileBytes(env));
    await configureContainerEgress(container, sourceUrl, resolved.egressHosts);
    const response = await container.fetch(new Request("http://container/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: resolved.url.href, maxBytes: maxFileBytes(env), policyRestricted: isPolicyRestrictedHost(sourceUrl.hostname) }),
      signal: AbortSignal.timeout(120_000)
    }));
    const analysis = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(JSON.stringify({ event: "downloader_container_analyze_failed", errorCode: cleanText(analysis.errorCode, 80) || "unknown", status: response.status }));
      throw new Error(cleanText(analysis.errorCode, 80) || `container_${response.status}`);
    }
    if (resolved.adapter) {
      analysis.site = sourceUrl.hostname;
      analysis.extractor = resolved.adapter;
      if (resolved.title) analysis.title = resolved.title;
      if (resolved.thumbnail) analysis.thumbnail = resolved.thumbnail;
    }
    const normalized = await normalizeAnalysis(analysis, sourceUrl.hostname, row.url_hash, jobId, env);
    const extractor = String(normalized.extractor || "unknown").slice(0, 80);
    const mediaType = String(normalized.media?.[0]?.mediaType || "unknown").slice(0, 40);
    const deliveryType = String(normalized.media?.[0]?.delivery || "unknown").slice(0, 40);
    const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'analyzed', extractor = ?, media_type = ?, delivery_type = ?, analysis_json = ?,
      analyzed_at = CURRENT_TIMESTAMP, processing_token = NULL, processing_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND identity_id = ? AND status = 'analyzing' AND processing_token = ?`)
      .bind(extractor, mediaType, deliveryType, JSON.stringify(normalized), jobId, identityId, analysisToken).run();
    if (update.meta?.changes) await auditSystem(env, identityId, row.service_link_id, "downloader_analyze_completed", "success", { jobId, hostname: sourceUrl.hostname, urlHash: row.url_hash, extractor, mediaCount: normalized.media.length });
  } catch (error) {
    await env.DB.prepare(`UPDATE downloader_jobs SET processing_token = NULL, processing_lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ? AND status = 'analyzing' AND processing_token = ?`)
      .bind(jobId, identityId, analysisToken).run();
    throw error;
  } finally {
    if (container) await releaseContainer(container);
  }
}

async function requestDownload(request, env, session, jobId) {
  ensureQueueConfigured(env);
  const body = await readJson(request, 8192);
  if (body.rightsConfirmed !== true) throw new HttpError(400, "保存する権利があるコンテンツであることを確認してください。");
  const sourceUrl = normalizeSourceUrl(body.url);
  const mediaId = normalizeMediaId(body.mediaId);
  if (!mediaId) throw new HttpError(400, "取得するメディアを選択してください。");
  const row = await ownedJob(env, session.identityId, jobId);
  if (row.url_hash !== await urlFingerprint(sourceUrl.href, env)) throw new HttpError(409, "解析時と同じURLを入力してください。");
  const analysis = parseJson(row.analysis_json, {});
  if (isPolicyRestrictedHost(sourceUrl.hostname) || isPolicyRestrictedAnalysis(analysis)) {
    if (body.youtubeRightsConfirmed !== true) {
      throw new HttpError(400, "YouTubeは、ご自身が投稿した動画または保存する権利を持つ動画であることを確認してください。", "youtube_rights_confirmation_required");
    }
    throw new HttpError(451, "YouTubeの利用規約により、このサービスから本体を取得できません。YouTube公式の保存機能をご利用ください。", "policy_restricted");
  }
  if (row.status === "processing" || row.status === "ready") return json({ job: publicJob(row) });
  if (row.status === "queued") {
    const selectedMediaId = row.selected_media_id || mediaId;
    const sealedRoute = analysis._sealedRoutes?.[selectedMediaId];
    if (!sealedRoute) throw new HttpError(409, "解析結果の有効期限が切れました。もう一度解析してください。");
    await sendJobMessage(env, { type: "download", jobId, identityId: session.identityId, mediaId: selectedMediaId, ...sealedRoute });
    return json({ job: publicJob(row) }, 202);
  }
  if (row.status !== "analyzed") throw new HttpError(409, "この解析結果から取得を開始できません。");
  const selected = (analysis.media || []).find((item) => item.mediaId === mediaId);
  if (!selected || selected.downloadable !== true || selected.drm === true || selected.loginRequired === true) {
    throw new HttpError(409, selected?.unavailableReason || "このメディアは取得できません。");
  }
  if (exceedsVideoTranscodeBudget(selected)) {
    throw new HttpError(422, "この動画は安全な処理時間内にMP4へ変換できない可能性が高いため取得できません。", "processing_budget_exceeded");
  }
  const sealedRoute = analysis._sealedRoutes?.[mediaId];
  if (!sealedRoute) throw new HttpError(409, "解析結果の有効期限が切れました。もう一度解析してください。");
  await enforceRateLimit(env, session.identityId, sourceUrl.hostname, "download", 5, 5);
  const inFlight = await env.DB.prepare(`SELECT 1 AS ok FROM downloader_jobs
    WHERE identity_id = ? AND id != ? AND status IN ('queued', 'processing') LIMIT 1`).bind(session.identityId, jobId).first();
  if (inFlight) throw new HttpError(429, "現在の取得が完了してから、次の取得を開始してください。");
  const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'queued', selected_media_id = ?, expected_size = ?,
    queued_at = CURRENT_TIMESTAMP, error_type = NULL, error_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND status = 'analyzed'`)
    .bind(mediaId, safeInteger(selected.estimatedSize), jobId, session.identityId).run();
  if (!update.meta?.changes) throw new HttpError(409, "取得状態が更新されています。画面を再読み込みしてください。");
  await env.DB.batch([rateEventStatement(env, session.identityId, sourceUrl.hostname, "download")]);
  await sendJobMessage(env, { type: "download", jobId, identityId: session.identityId, mediaId, ...sealedRoute });
  await audit(env, request, session, "downloader_download_requested", "success", { jobId, hostname: sourceUrl.hostname, urlHash: row.url_hash, mediaId });
  return json({ job: publicJob(await ownedJob(env, session.identityId, jobId)) }, 202);
}

async function processDownloadMessage(env, message) {
  ensureContainerConfigured(env);
  const jobId = String(message.jobId || "");
  const identityId = String(message.identityId || "");
  const row = await env.DB.prepare("SELECT * FROM downloader_jobs WHERE id = ? AND identity_id = ?").bind(jobId, identityId).first();
  if (!row || ["ready", "deleted", "expired"].includes(row.status)) return;
  if (!["queued", "processing"].includes(row.status)) throw new Error("job_not_processable");
  if (isPolicyRestrictedAnalysis(parseJson(row.analysis_json, {}))) throw new Error("policy_restricted");
  const processingToken = crypto.randomUUID();
  const processTimeoutSeconds = clampNumber(env.PROCESS_TIMEOUT_SECONDS, 60, 720, 720);
  // Claim covers cold-start health wait, the Container's absolute deadline,
  // response transport, and D1/audit finalization. It remains inside Queues'
  // 15-minute wall-clock envelope and prevents a second delivery from taking
  // the job while the first cold-started Container is still validly working.
  const leaseExpiresAt = nowSeconds() + Math.ceil(CONTAINER_HEALTH_TIMEOUT_MS / 1000) +
    processTimeoutSeconds + Math.ceil(QUEUE_FINALIZATION_RESERVE_MS / 1000);
  const claim = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'processing', processing_at = COALESCE(processing_at, CURRENT_TIMESTAMP),
    processing_token = ?, processing_lease_expires_at = ?, progress_stage = 'starting', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND (
      status = 'queued' OR (status = 'processing' AND (processing_lease_expires_at IS NULL OR processing_lease_expires_at <= ?))
    )`).bind(processingToken, leaseExpiresAt, jobId, identityId, nowSeconds()).run();
  if (!claim.meta?.changes) return;
  await auditSystem(env, identityId, row.service_link_id, "downloader_download_started", "success", { jobId, hostname: row.source_hostname });
  try {
    const capability = await decryptPrivatePayload(message, env);
    if (capability.sourceHash !== row.url_hash || capability.jobId !== jobId || capability.mediaId !== String(message.mediaId || "") ||
      !capability.route || typeof capability.route !== "object") {
      throw new Error("download_capability_mismatch");
    }
    const routeUrl = normalizeSourceUrl(capability.route.url);
    if (isPolicyRestrictedHost(routeUrl.hostname)) throw new Error("policy_restricted");
    const objectKey = `downloads/${jobId}/${crypto.randomUUID()}`;
    const expiresAt = nowSeconds() + downloadTtl(env);
    const grant = await createInternalGrant({ jobId, processingToken, objectKey, expiresAt, maxBytes: maxBytesForRow(env, row) }, env);
    const container = getContainer(env.DOWNLOADER_CONTAINER, `job-${jobId}`);
    try {
      const healthStartedAt = Date.now();
      await requireHealthyContainer(container);
      const containerHealthMs = Math.max(0, Date.now() - healthStartedAt);
      await configureContainerEgress(container, routeUrl, capability.route.egressHosts);
      const response = await container.fetch(new Request("http://container/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          route: capability.route,
          jobId,
          objectKey,
          uploadGrant: grant,
          maxBytes: maxBytesForRow(env, row),
          timeoutSeconds: processTimeoutSeconds
        }),
        signal: AbortSignal.timeout(processTimeoutSeconds * 1000 + CONTAINER_RESPONSE_GRACE_MS)
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw containerResponseError(result.errorCode, response.status);
      const normalization = ["PASS_THROUGH", "REMUX", "PARTIAL_TRANSCODE", "FULL_TRANSCODE", "NOT_APPLICABLE"].includes(result.normalization)
        ? result.normalization : "UNKNOWN";
      const metrics = normalizeContainerMetrics(result.metrics);
      const containerCpuMs = metrics && (metrics.cpuUserMs !== undefined || metrics.cpuSystemMs !== undefined)
        ? (metrics.cpuUserMs || 0) + (metrics.cpuSystemMs || 0)
        : null;
      if (metrics) console.log(JSON.stringify({ event: "downloader_container_metrics", jobId, normalization, containerHealthMs, ...metrics }));
      const phases = metrics?.phaseMs || {};
      await env.DB.prepare(`UPDATE downloader_jobs SET normalization_mode = ?, container_health_ms = ?,
        container_wall_ms = COALESCE(?, container_wall_ms), container_cpu_ms = COALESCE(?, container_cpu_ms),
        container_peak_rss_bytes = COALESCE(?, container_peak_rss_bytes), container_work_bytes = COALESCE(?, container_work_bytes),
        download_ms = COALESCE(?, download_ms), validation_ms = COALESCE(?, validation_ms),
        processing_ms = COALESCE(?, processing_ms), security_scan_ms = COALESCE(?, security_scan_ms),
        upload_ms = COALESCE(?, upload_ms), progress_stage = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND identity_id = ? AND status = 'ready'`).bind(
          normalization, containerHealthMs, metrics?.wallMs ?? null,
          containerCpuMs,
          metrics?.containerPeakRssBytes ?? null, metrics?.observedWorkBytes ?? null,
          phases.download ?? null, phases.validation ?? null, phases.processing ?? null,
          phases.securityScan ?? null, phases.upload ?? null, jobId, identityId
        ).run();
      const ready = await env.DB.prepare("SELECT status FROM downloader_jobs WHERE id = ? AND identity_id = ?").bind(jobId, identityId).first();
      if (ready?.status !== "ready") throw new Error("container_upload_not_committed");
      await auditSystem(env, identityId, row.service_link_id, "downloader_scan_passed", "success", { jobId, hostname: row.source_hostname });
      await auditSystem(env, identityId, row.service_link_id, "downloader_download_completed", "success", { jobId, hostname: row.source_hostname, actualSize: result.actualSize || null });
    } finally {
      await releaseContainer(container);
    }
  } catch (error) {
    await env.DB.prepare(`UPDATE downloader_jobs SET processing_token = NULL, processing_lease_expires_at = NULL,
      progress_stage = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND identity_id = ? AND status = 'processing' AND processing_token = ?`)
      .bind(jobId, identityId, processingToken).run();
    throw error;
  }
}

function normalizeContainerMetrics(value) {
  if (!value || typeof value !== "object") return null;
  const names = ["wallMs", "cpuUserMs", "cpuSystemMs", "containerPeakRssBytes", "observedWorkBytes"];
  const metrics = {};
  for (const name of names) {
    const number = Number(value[name]);
    if (Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) metrics[name] = Math.round(number);
  }
  const phaseNames = ["download", "validation", "processing", "securityScan", "upload"];
  const phaseMs = {};
  for (const name of phaseNames) {
    const number = Number(value.phaseMs?.[name]);
    if (Number.isFinite(number) && number >= 0 && number <= 720_000) phaseMs[name] = Math.round(number);
  }
  if (Object.keys(phaseMs).length) metrics.phaseMs = phaseMs;
  return Object.keys(metrics).length ? metrics : null;
}

async function markDownloadFailed(env, message, error) {
  const jobId = String(message?.jobId || "");
  const identityId = String(message?.identityId || "");
  const row = await env.DB.prepare("SELECT service_link_id, source_hostname FROM downloader_jobs WHERE id = ? AND identity_id = ?")
    .bind(jobId, identityId).first();
  if (!row) return;
  const safe = queueErrorReason(error);
  const failure = classifyUsageError(error);
  const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'failed', error_type = ?, error_reason = ?, failure_category = ?,
    processing_token = NULL, processing_lease_expires_at = NULL, progress_stage = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND status IN ('queued', 'processing')`)
    .bind(failure.code, safe, failure.category, jobId, identityId).run();
  if (update.meta?.changes) await auditSystem(env, identityId, row.service_link_id, "downloader_download_failed", "failure", { jobId, hostname: row.source_hostname, reason: safe });
}

async function markAnalysisFailed(env, message, error) {
  const jobId = String(message?.jobId || "");
  const identityId = String(message?.identityId || "");
  const row = await env.DB.prepare("SELECT service_link_id, source_hostname FROM downloader_jobs WHERE id = ? AND identity_id = ?")
    .bind(jobId, identityId).first();
  if (!row) return;
  const failure = classifyUsageError(error);
  const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'failed', error_type = ?, failure_category = ?,
    error_reason = 'このURLからメディアを確認できませんでした。', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND status = 'analyzing'`).bind(failure.code, failure.category, jobId, identityId).run();
  if (update.meta?.changes) await auditSystem(env, identityId, row.service_link_id, "downloader_analyze_failed", "failure", { jobId, hostname: row.source_hostname, reason: queueErrorReason(error) });
}

async function handleContainerInternalRequest(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/progress") return handleContainerProgress(request, env);
  if (path === "/upload") return handleContainerUpload(request, env);
  return new Response("Not Found", { status: 404 });
}

async function handleContainerProgress(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const grant = await verifyInternalGrant(request.headers.get("Authorization"), env);
  if (!grant) return new Response("Unauthorized", { status: 401 });
  const body = await readJson(request, 1024);
  const stage = String(body.stage || "");
  if (!CONTAINER_PROGRESS_STAGES.has(stage)) return new Response("Invalid stage", { status: 400 });
  const update = await env.DB.prepare(`UPDATE downloader_jobs SET progress_stage = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'processing' AND processing_token = ? AND processing_lease_expires_at > ?`)
    .bind(stage, grant.jobId, grant.processingToken, nowSeconds()).run();
  return update.meta?.changes === 1 ? json({ ok: true }) : new Response("Conflict", { status: 409 });
}

async function handleContainerUpload(request, env) {
  if (request.method !== "PUT") return new Response("Method Not Allowed", { status: 405 });
  const grant = await verifyInternalGrant(request.headers.get("Authorization"), env);
  if (!grant) return new Response("Unauthorized", { status: 401 });
  const size = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isSafeInteger(size) || size <= 0 || size > grant.maxBytes) return new Response("Payload Too Large", { status: 413 });
  const sha256 = String(request.headers.get("X-Content-SHA256") || "").toLowerCase();
  const mimeType = String(request.headers.get("Content-Type") || "application/octet-stream").slice(0, 120);
  const filename = sanitizeFilename(decodeHeaderValue(request.headers.get("X-Filename")), mimeType);
  const normalization = normalizeNormalizationMode(request.headers.get("X-Normalization"));
  const sourceBytes = safeMetricHeader(request.headers.get("X-Source-Bytes"), grant.maxBytes);
  const containerWallMs = safeMetricHeader(request.headers.get("X-Container-Wall-Ms"), 720_000);
  const cpuUserMs = safeMetricHeader(request.headers.get("X-Container-CPU-User-Ms"), 720_000);
  const cpuSystemMs = safeMetricHeader(request.headers.get("X-Container-CPU-System-Ms"), 720_000);
  const containerPeakRssBytes = safeMetricHeader(request.headers.get("X-Container-Peak-RSS-Bytes"), 16 * 1024 ** 3);
  const containerWorkBytes = safeMetricHeader(request.headers.get("X-Container-Work-Bytes"), 12 * 1024 ** 3);
  const downloadMs = safeMetricHeader(request.headers.get("X-Phase-Download-Ms"), 720_000);
  const validationMs = safeMetricHeader(request.headers.get("X-Phase-Validation-Ms"), 720_000);
  const processingMs = safeMetricHeader(request.headers.get("X-Phase-Processing-Ms"), 720_000);
  const securityScanMs = safeMetricHeader(request.headers.get("X-Phase-Security-Scan-Ms"), 720_000);
  if (!/^[a-f0-9]{64}$/.test(sha256)) return new Response("Invalid digest", { status: 400 });
  const row = await env.DB.prepare(`SELECT status, identity_id FROM downloader_jobs
    WHERE id = ? AND status = 'processing' AND processing_token = ? AND processing_lease_expires_at > ?`)
    .bind(grant.jobId, grant.processingToken, nowSeconds()).first();
  if (!row) {
    const ready = await env.DB.prepare(`SELECT status, object_key, actual_size, sha256, expires_at FROM downloader_jobs
      WHERE id = ?`).bind(grant.jobId).first();
    const sameCommittedUpload = ready?.status === "ready" && ready.object_key === grant.objectKey &&
      Number(ready.actual_size) === size && ready.sha256 === sha256 && Number(ready.expires_at || 0) > nowSeconds();
    return sameCommittedUpload ? json({ stored: true, expiresAt: Number(ready.expires_at) }) : new Response("Conflict", { status: 409 });
  }
  // A Container request can be retried at the transport boundary. Claim the upload in D1
  // before streaming to R2 so only one request can write/delete this signed object key.
  const uploadToken = `upload:${grant.processingToken}`;
  const uploadClaim = await env.DB.prepare(`UPDATE downloader_jobs SET processing_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'processing' AND processing_token = ? AND processing_lease_expires_at > ?`)
    .bind(uploadToken, grant.jobId, grant.processingToken, nowSeconds()).run();
  if (uploadClaim.meta?.changes !== 1) return new Response("Conflict", { status: 409 });
  console.log(JSON.stringify({ event: "downloader_container_upload_received", jobId: grant.jobId, size }));
  let committed = false;
  try {
    await env.DOWNLOADS.put(grant.objectKey, request.body, {
      httpMetadata: { contentType: mimeType, contentDisposition: contentDisposition(filename) },
      customMetadata: { jobId: grant.jobId, processingToken: grant.processingToken, sha256 }
    });
    await safeRecordUsageItems(env, row.identity_id, [{ metric: "platform", dimension: "r2_class_a", count: 1 }]);
    const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'ready', object_key = ?, actual_size = ?, sha256 = ?,
      mime_type = ?, safe_filename = ?, downloaded_at = CURRENT_TIMESTAMP, expires_at = ?, processing_token = NULL,
      processing_lease_expires_at = NULL, normalization_mode = ?, source_bytes = ?, container_wall_ms = ?,
      container_cpu_ms = ?, container_peak_rss_bytes = ?, container_work_bytes = ?, download_ms = ?,
      validation_ms = ?, processing_ms = ?, security_scan_ms = ?, progress_stage = 'finalizing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing' AND processing_token = ?`)
      .bind(grant.objectKey, size, sha256, mimeType, filename, grant.expiresAt, normalization, sourceBytes,
        containerWallMs, cpuUserMs + cpuSystemMs, containerPeakRssBytes, containerWorkBytes,
        downloadMs, validationMs, processingMs, securityScanMs, grant.jobId, uploadToken).run();
    committed = update.meta?.changes === 1;
  } finally {
    if (!committed) {
      await env.DOWNLOADS.delete(grant.objectKey);
      await env.DB.prepare(`UPDATE downloader_jobs SET processing_token = NULL, processing_lease_expires_at = NULL,
        progress_stage = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'processing' AND processing_token = ?`).bind(grant.jobId, uploadToken).run();
    }
  }
  if (!committed) {
    return new Response("Conflict", { status: 409 });
  }
  console.log(JSON.stringify({ event: "downloader_container_upload_committed", jobId: grant.jobId, size }));
  await sendJobMessage(env, { type: "delete", jobId: grant.jobId, identityId: row.identity_id }, { delaySeconds: Math.max(1, grant.expiresAt - nowSeconds()) });
  return json({ stored: true, expiresAt: grant.expiresAt });
}

async function listJobs(env, session) {
  const rows = await env.DB.prepare(`SELECT * FROM downloader_jobs WHERE identity_id = ? ORDER BY created_at DESC LIMIT 50`)
    .bind(session.identityId).all();
  return json({ jobs: (rows.results || []).map(publicJob) });
}

async function getJob(env, session, jobId) {
  return json({ job: publicJob(await ownedJob(env, session.identityId, jobId)) });
}

async function ownedJob(env, identityId, jobId) {
  const row = await env.DB.prepare("SELECT * FROM downloader_jobs WHERE id = ? AND identity_id = ?").bind(jobId, identityId).first();
  if (!row) throw new HttpError(404, "取得ジョブが見つかりません。");
  return row;
}

async function serveDownload(request, env, session, jobId) {
  const row = await ownedJob(env, session.identityId, jobId);
  if (row.status !== "ready" || !row.object_key) throw new HttpError(409, "ファイルはまだダウンロードできません。");
  if (Number(row.expires_at || 0) <= nowSeconds()) {
    await deleteJobObject(env, jobId, "expired");
    throw new HttpError(410, "ファイルの保存期限が終了しました。");
  }
  const object = await env.DOWNLOADS.get(row.object_key);
  await safeRecordUsageItems(env, session.identityId, [{ metric: "platform", dimension: "r2_class_b", count: 1 }]);
  if (!object) {
    await env.DB.prepare(`UPDATE downloader_jobs SET status = 'expired', error_type = 'object_missing',
      error_reason = 'ファイルの保存期限が終了しました。', progress_stage = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(jobId).run();
    throw new HttpError(410, "ファイルの保存期限が終了しました。");
  }
  await recordFileDeliveryAttempt(request, env, session, row, object.size);
  const headers = new Headers({
    "Content-Type": row.mime_type || "application/octet-stream",
    "Content-Length": String(object.size),
    "Content-Disposition": contentDisposition(row.safe_filename || "download.bin"),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive"
  });
  return new Response(object.body, { headers });
}

async function deleteOwnedJob(env, session, jobId) {
  await ownedJob(env, session.identityId, jobId);
  await deleteJobObject(env, jobId, "deleted");
  await auditSystem(env, session.identityId, session.serviceLinkId, "downloader_deleted", "success", { jobId });
}

async function deleteJobObject(env, jobId, finalStatus) {
  const row = await env.DB.prepare("SELECT id, object_key, status FROM downloader_jobs WHERE id = ?").bind(jobId).first();
  if (!row || row.status === "deleted") return;
  if (row.object_key) await env.DOWNLOADS.delete(row.object_key);
  await env.DB.prepare(`UPDATE downloader_jobs SET status = ?, object_key = NULL, deleted_at = CURRENT_TIMESTAMP,
    progress_stage = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(finalStatus === "expired" ? "expired" : "deleted", jobId).run();
}

async function cleanupExpiredJobs(env) {
  const now = nowSeconds();
  const expired = await env.DB.prepare(`SELECT id FROM downloader_jobs WHERE object_key IS NOT NULL AND expires_at <= ? LIMIT 100`).bind(now).all();
  for (const row of expired.results || []) await deleteJobObject(env, row.id, "expired");
  const stale = await env.DB.prepare(`SELECT id, object_key FROM downloader_jobs
    WHERE status IN ('analyzing', 'queued', 'processing') AND created_at < ? LIMIT 100`)
    .bind(sqliteUtcTimestamp(Date.now() - 60 * 60 * 1000)).all();
  for (const row of stale.results || []) {
    if (row.object_key) await env.DOWNLOADS.delete(row.object_key);
    await env.DB.prepare(`UPDATE downloader_jobs SET status = 'failed', object_key = NULL, error_type = 'stale_job',
      failure_category = 'other_failed', error_reason = '処理が完了しなかったため終了しました。',
      processing_token = NULL, processing_lease_expires_at = NULL, progress_stage = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
  }
  await env.DB.prepare(`UPDATE downloader_jobs SET analysis_json = '{}', source_path_hint = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE analysis_json != '{}' AND status IN ('analyzed', 'failed', 'rejected', 'expired', 'deleted') AND updated_at < ?`)
    .bind(sqliteUtcTimestamp(Date.now() - 60 * 60 * 1000)).run();
  await cleanupOrphanObjects(env);
  await env.DB.prepare("DELETE FROM downloader_rate_events WHERE occurred_at < ?")
    .bind(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()).run();
  await env.DB.prepare("DELETE FROM downloader_file_delivery_attempts WHERE created_at < ?")
    .bind(sqliteUtcTimestamp(Date.now() - 48 * 60 * 60 * 1000)).run();
}

async function cleanupOrphanObjects(env) {
  const cleanupStartedAt = Date.now();
  let cursor;
  let pages = 0;
  do {
    const listed = await env.DOWNLOADS.list({ prefix: "downloads/", cursor, limit: 250, include: ["customMetadata"] });
    await safeRecordUsageItems(env, "system", [{ metric: "platform", dimension: "r2_class_a", count: 1 }]);
    for (const object of listed.objects || []) {
      const jobId = String(object.customMetadata?.jobId || object.key.split("/")[1] || "");
      const row = jobId ? await env.DB.prepare("SELECT object_key, status, expires_at, processing_token, processing_lease_expires_at FROM downloader_jobs WHERE id = ?").bind(jobId).first() : null;
      const current = row?.status === "ready" && row.object_key === object.key && Number(row.expires_at || 0) > nowSeconds();
      const uploading = row?.status === "processing" && row.processing_token === object.customMetadata?.processingToken &&
        Number(row.processing_lease_expires_at || 0) > nowSeconds();
      // R2 put and the D1 ready transition cannot be committed atomically. A scheduled cleanup
      // that overlaps that narrow boundary must not delete the just-created final artifact.
      // Unknown/malformed upload timestamps also fail closed and are retained for a later audit.
      const pastGrace = orphanObjectIsPastGrace(object.uploaded, cleanupStartedAt, ORPHAN_OBJECT_GRACE_MS);
      if (!current && !uploading && pastGrace) await env.DOWNLOADS.delete(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    pages += 1;
  } while (cursor && pages < 20);
}

async function enforceRateLimit(env, identityId, hostname, action, userLimit, hostLimit) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const [user, host] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM downloader_rate_events WHERE identity_id = ? AND action = ? AND occurred_at >= ?")
      .bind(identityId, action, cutoff).first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM downloader_rate_events WHERE source_hostname = ? AND action = ? AND occurred_at >= ?")
      .bind(hostname, action, cutoff).first()
  ]);
  if (Number(user?.count || 0) >= userLimit || Number(host?.count || 0) >= hostLimit) {
    throw new HttpError(429, "利用回数が上限に達しました。時間を置いてお試しください。", "rate_limited");
  }
}

function rateEventStatement(env, identityId, hostname, action) {
  return env.DB.prepare(`INSERT INTO downloader_rate_events (id, identity_id, source_hostname, action, occurred_at)
    VALUES (?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), identityId, hostname, action, new Date().toISOString());
}

function requireParentUsageSession(session) {
  if (!isParentUsageSession(session, SESSION_ROLE)) {
    throw new HttpError(403, "利用状況は第一管理者だけが確認できます。", "parent_account_required");
  }
}

async function usageDashboard(env) {
  const now = Date.now();
  const nowEpoch = Math.floor(now / 1000);
  const today = jstUsageDate(now);
  const month = jstUsageMonth(now);
  const monthStart = `${month}-01`;
  const recentStart = jstUsageDate(now - 29 * 24 * 60 * 60 * 1000);
  const [todayRows, monthRows, allRows, recentRows, recentRates, activeToday, activeMonth, activeAll] = await Promise.all([
    queryUsageRows(env, "day_jst = ?", [today]),
    queryUsageRows(env, "day_jst >= ? AND day_jst <= ?", [monthStart, today]),
    queryUsageRows(env, "1 = 1", []),
    env.DB.prepare(`SELECT day_jst, metric, dimension, SUM(event_count) AS event_count,
      SUM(byte_count) AS byte_count, SUM(value_sum) AS value_sum, MAX(value_max) AS value_max
      FROM downloader_usage_daily WHERE day_jst >= ? GROUP BY day_jst, metric, dimension ORDER BY day_jst ASC`)
      .bind(recentStart).all(),
    env.DB.prepare(`SELECT action, COUNT(*) AS count FROM downloader_rate_events
      WHERE occurred_at >= ? GROUP BY action`).bind(new Date(now - 60 * 60 * 1000).toISOString()).all(),
    activeStorageByteSeconds(env, nowEpoch, Math.floor(Date.parse(`${today}T00:00:00+09:00`) / 1000)),
    activeStorageByteSeconds(env, nowEpoch, Math.floor(Date.parse(`${monthStart}T00:00:00+09:00`) / 1000)),
    activeStorageByteSeconds(env, nowEpoch, 0)
  ]);
  const periods = {
    today: aggregateUsageRows(todayRows),
    month: aggregateUsageRows(monthRows),
    all: aggregateUsageRows(allRows)
  };
  periods.today.r2StorageByteSeconds += activeToday;
  periods.month.r2StorageByteSeconds += activeMonth;
  periods.all.r2StorageByteSeconds += activeAll;
  const dailyGroups = new Map();
  for (const row of recentRows.results || []) {
    if (!dailyGroups.has(row.day_jst)) dailyGroups.set(row.day_jst, []);
    dailyGroups.get(row.day_jst).push(row);
  }
  const recentDaily = [...dailyGroups].map(([date, rows]) => {
    const usage = aggregateUsageRows(rows);
    return {
      date,
      analyzeRequests: usage.analyzeRequests,
      downloadRequests: usage.downloadRequests,
      processingSuccesses: usage.processingSuccesses,
      fileDeliveryStarts: usage.fileDeliveryStarts,
      rejected: usage.rejected,
      failed: usage.failed,
      deliveredBytes: usage.deliveredBytes
    };
  });
  const lastHour = Object.fromEntries((recentRates.results || []).map((row) => [row.action, Number(row.count || 0)]));
  return json({
    generatedAt: new Date(now).toISOString(),
    timezone: "Asia/Tokyo",
    periods,
    recentDaily,
    signals: usageSignals(periods.today, lastHour),
    pricing: estimateDownloaderCost(periods.month)
  });
}

async function queryUsageRows(env, clause, bindings) {
  const statement = env.DB.prepare(`SELECT metric, dimension, SUM(event_count) AS event_count,
    SUM(byte_count) AS byte_count, SUM(value_sum) AS value_sum, MAX(value_max) AS value_max
    FROM downloader_usage_daily WHERE ${clause} GROUP BY metric, dimension`);
  const rows = bindings.length ? await statement.bind(...bindings).all() : await statement.all();
  return rows.results || [];
}

async function activeStorageByteSeconds(env, nowEpoch, periodStartEpoch) {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(actual_size * MAX(0, ? - MAX(strftime('%s', downloaded_at), ?))), 0) AS value
    FROM downloader_jobs WHERE status = 'ready' AND object_key IS NOT NULL AND actual_size IS NOT NULL AND downloaded_at IS NOT NULL`)
    .bind(nowEpoch, periodStartEpoch).first();
  return Math.max(0, Number(row?.value || 0));
}

function usageSignals(today, lastHour) {
  const scannerErrors = today.security.clamav_error + today.security.yara_error +
    today.security.scanner_timeout + today.security.scanner_unavailable;
  const alerts = [];
  if (Number(lastHour.analyze || 0) >= 25) alerts.push("直近1時間のURL解析が多くなっています。");
  if (Number(lastHour.download || 0) >= 4) alerts.push("直近1時間のダウンロード要求が上限に近づいています。");
  if (today.deliveredBytes >= 5 * 1024 ** 3) alerts.push("本日の総配信容量が5 GBを超えています。");
  if (today.rejected + today.failed >= 10) alerts.push("本日の拒否・失敗が多くなっています。");
  if (today.security.rate_limited > 0) alerts.push("本日、rate limitによる拒否が発生しています。");
  if (scannerErrors > 0) alerts.push("本日、scannerの異常またはtimeoutが発生しています。");
  if (today.security.malware_detected + today.security.yara_detected > 0) alerts.push("本日、脅威検知による拒否が発生しています。");
  return {
    lastHourAnalyze: Number(lastHour.analyze || 0),
    lastHourDownload: Number(lastHour.download || 0),
    alerts
  };
}

async function recordRequestFailure(env, identityId, error) {
  if (error?.usageOutcomeRecorded === true) return;
  const failure = classifyUsageError(error);
  await safeRecordUsageItems(env, identityId, [
    { metric: "outcome", dimension: failure.outcome, count: 1 },
    { metric: "security", dimension: failure.category, count: 1 }
  ]);
}

async function safeRecordUsageItems(env, identityId, items) {
  if (!env?.DB || !Array.isArray(items) || !items.length) return;
  const safeIdentity = safeUsageIdentityId(identityId);
  try {
    await env.DB.batch(items.map((item) => usageIncrementStatement(env, safeIdentity, item)));
  } catch (error) {
    console.error(JSON.stringify({ event: "downloader_usage_record_failed", error: safeErrorName(error) }));
  }
}

function usageIncrementStatement(env, identityId, item) {
  const metric = cleanText(item.metric, 40) || "unknown";
  const dimension = cleanText(item.dimension, 80) || "unknown";
  const count = safeUsageNumber(item.count);
  const bytes = safeUsageNumber(item.bytes);
  const valueSum = safeUsageNumber(item.valueSum);
  const valueMax = safeUsageNumber(item.valueMax);
  return env.DB.prepare(`INSERT INTO downloader_usage_daily
    (day_jst, identity_id, metric, dimension, event_count, byte_count, value_sum, value_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day_jst, identity_id, metric, dimension) DO UPDATE SET
      event_count = event_count + excluded.event_count,
      byte_count = byte_count + excluded.byte_count,
      value_sum = value_sum + excluded.value_sum,
      value_max = MAX(value_max, excluded.value_max),
      updated_at = CURRENT_TIMESTAMP`)
    .bind(jstUsageDate(), identityId, metric, dimension, count, bytes, valueSum, valueMax);
}

async function sendJobMessage(env, body, options) {
  await env.JOBS.send(body, options);
  await safeRecordUsageItems(env, safeUsageIdentityId(body?.identityId), [{ metric: "platform", dimension: "queue_write", count: 1 }]);
}

async function recordFileDeliveryAttempt(request, env, session, row, size) {
  try {
    if (!env.INTERNAL_SIGNING_SECRET) throw new Error("usage_signing_secret_missing");
    const supplied = String(new URL(request.url).searchParams.get("attempt") || "");
    const logicalAttempt = /^[A-Za-z0-9_-]{8,128}$/.test(supplied)
      ? supplied
      : `legacy\0${session.sessionId || "session"}\0${Math.floor(nowSeconds() / 300)}`;
    const attemptId = await hmac(`delivery-attempt-v1\0${row.id}\0${logicalAttempt}`, env.INTERNAL_SIGNING_SECRET);
    await env.DB.prepare(`INSERT OR IGNORE INTO downloader_file_delivery_attempts
      (job_id, attempt_id, identity_id, day_jst, byte_count) VALUES (?, ?, ?, ?, ?)`)
      .bind(row.id, attemptId, session.identityId, jstUsageDate(), safeUsageNumber(size)).run();
  } catch (error) {
    console.error(JSON.stringify({ event: "downloader_delivery_usage_failed", jobId: safeQueueJobId(row?.id), error: safeErrorName(error) }));
  }
}

function safeUsageIdentityId(value) {
  const identityId = String(value || "system");
  return /^[A-Za-z0-9_-]{1,128}$/.test(identityId) ? identityId : "system";
}

function safeUsageNumber(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

async function normalizeAnalysis(input, hostname, sourceHash, jobId, env) {
  const media = [];
  const sealedRoutes = {};
  for (const [index, item] of (Array.isArray(input.media) ? input.media : []).slice(0, 50).entries()) {
    const mediaId = normalizeMediaId(item.mediaId) || `media-${index + 1}`;
    let downloadable = item.downloadable === true;
    if (downloadable) {
      const route = normalizeDownloadRoute(item._downloadRoute);
      if (route) sealedRoutes[mediaId] = await encryptPrivatePayload({ sourceHash, jobId, mediaId, route }, env);
      else downloadable = false;
    }
    media.push({
      mediaId,
      title: cleanText(item.title, 240) || `メディア ${index + 1}`,
      mediaType: ["video", "audio", "image"].includes(item.mediaType) ? item.mediaType : "video",
      container: cleanText(item.container, 40) || null,
      mime: cleanText(item.mime, 100) || null,
      estimatedSize: safeInteger(item.estimatedSize),
      width: safeInteger(item.width), height: safeInteger(item.height), fps: safeInteger(item.fps), duration: safeInteger(item.duration),
      videoCodec: cleanText(item.videoCodec, 80) || null,
      audioCodec: cleanText(item.audioCodec, 80) || null,
      delivery: cleanText(item.delivery, 40) || "unknown",
      drm: Boolean(item.drm), loginRequired: Boolean(item.loginRequired),
      downloadable,
      unavailableReason: cleanText(item.unavailableReason, 240) || (downloadable ? null : "安全な取得経路を確定できませんでした。"),
      normalization: cleanText(item.normalization, 40) || (item.mediaType === "video" ? "AUTO" : "NOT_APPLICABLE")
    });
  }
  return {
    site: cleanText(input.site, 120) || hostname,
    hostname,
    finalHostname: cleanText(input.finalHostname, 253) || hostname,
    title: cleanText(input.title, 240) || null,
    uploader: cleanText(input.uploader, 160) || null,
    publishedAt: cleanText(input.publishedAt, 40) || null,
    thumbnail: safeThumbnail(input.thumbnail),
    extractor: cleanText(input.extractor, 80) || "unknown",
    browserFallbackUsed: Boolean(input.browserFallbackUsed),
    warning: cleanText(input.warning, 300) || null,
    media,
    _sealedRoutes: sealedRoutes
  };
}

function normalizeDownloadRoute(value) {
  try {
    if (!value || value.version !== 1 || !["direct", "adaptive", "yt-dlp"].includes(value.kind)) return null;
    const url = normalizeSourceUrl(value.url);
    if (isPolicyRestrictedHost(url.hostname)) return null;
    const delivery = ["direct", "hls", "dash"].includes(value.delivery) ? value.delivery : "direct";
    if (value.kind === "direct" && delivery !== "direct") return null;
    if (value.kind === "adaptive" && !["hls", "dash"].includes(delivery)) return null;
    const route = {
      version: 1,
      kind: value.kind,
      url: url.href,
      delivery,
      filename: cleanText(value.filename, 120) || "download",
      mime: cleanText(value.mime, 120) || null
    };
    const egressHosts = [];
    for (const host of Array.isArray(value.egressHosts) ? value.egressHosts.slice(0, 32) : []) {
      try {
        const normalized = normalizeSourceUrl(`https://${String(host || "").trim()}/`).hostname;
        if (!egressHosts.includes(normalized)) egressHosts.push(normalized);
      } catch { /* invalid or private host is intentionally omitted */ }
    }
    if (!egressHosts.includes(url.hostname)) egressHosts.push(url.hostname);
    route.egressHosts = egressHosts;
    if (value.kind === "yt-dlp") {
      route.playlistIndex = safeInteger(value.playlistIndex);
      route.formatSelector = cleanFormatSelector(value.formatSelector);
      if (!route.formatSelector) return null;
    }
    return route;
  } catch { return null; }
}

async function resolveAnalysisSource(container, sourceUrl, maxBytes) {
  if (sourceUrl.hostname !== IMAGE_SHARE_SOURCE_HOST) {
    return { url: sourceUrl, adapter: null, title: null, thumbnail: null, egressHosts: [] };
  }
  // Only the named landing-page adapter receives access to its documented
  // metadata API. The discovered URL is returned privately to this Worker,
  // revalidated here, and allowlisted before the Container inspects it.
  await configureContainerEgress(container, sourceUrl, [IMAGE_SHARE_API_HOST]);
  const response = await container.fetch(new Request("http://container/resolve-adapter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: sourceUrl.href, maxBytes }),
    signal: AbortSignal.timeout(60_000)
  }));
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw containerResponseError(result.errorCode, response.status);
  if (result.adapter !== "image-share") throw new Error("adapter_response_invalid");
  const discovered = normalizeSourceUrl(result.url);
  if (isPolicyRestrictedHost(discovered.hostname)) throw new Error("policy_restricted");
  return {
    url: discovered,
    adapter: "image-share",
    title: cleanText(result.title, 240) || null,
    thumbnail: safeThumbnail(result.thumbnail),
    egressHosts: [IMAGE_SHARE_API_HOST, discovered.hostname]
  };
}

async function configureContainerEgress(container, sourceUrl, analyzedHosts = []) {
  if (typeof container?.setAllowedHosts !== "function") throw new Error("container_egress_allowlist_unavailable");
  const hosts = new Set(["r2.tlain.internal"]);
  const addFamily = (value) => {
    let hostname;
    try { hostname = normalizeSourceUrl(`https://${String(value || "").trim()}/`).hostname; } catch { return; }
    hosts.add(hostname);
    hosts.add(`*.${hostname}`);
    if (hostname.startsWith("www.")) {
      const root = hostname.slice(4);
      hosts.add(root);
      hosts.add(`*.${root}`);
    }
  };
  addFamily(sourceUrl.hostname);
  for (const host of Array.isArray(analyzedHosts) ? analyzedHosts.slice(0, 32) : []) addFamily(host);
  if (isPolicyRestrictedHost(sourceUrl.hostname)) for (const host of YOUTUBE_ANALYSIS_HOSTS) hosts.add(host);
  await container.setAllowedHosts([...hosts]);
}

async function requireHealthyContainer(container) {
  let response;
  try {
    response = await container.fetch(new Request("http://container/health", {
      signal: AbortSignal.timeout(CONTAINER_HEALTH_TIMEOUT_MS)
    }));
  } catch (error) {
    console.error(JSON.stringify({ event: "downloader_container_health_failed", error: safeErrorName(error) }));
    throw new Error("container_unhealthy");
  }
  const health = await response.json().catch(() => ({}));
  const healthy = response.ok && health.ok === true && health.draining === false &&
    health.clamav?.healthy === true && health.clamav?.daemonReady === true &&
    health.yara?.healthy === true && health.yara?.verified === true;
  if (!healthy) {
    console.error(JSON.stringify({
      event: "downloader_container_unhealthy",
      status: response.status,
      draining: health.draining === true,
      clamavHealthy: health.clamav?.healthy === true,
      daemonReady: health.clamav?.daemonReady === true,
      yaraHealthy: health.yara?.healthy === true,
      yaraVerified: health.yara?.verified === true
    }));
    throw new Error("container_unhealthy");
  }
}

function safeThumbnail(value) {
  try {
    const url = normalizeSourceUrl(value);
    // Signed thumbnail query strings can contain reusable tokens and must not
    // be persisted in D1. Public thumbnails normally remain valid without it.
    url.search = "";
    return url.href.length <= 1024 ? url.href : null;
  } catch { return null; }
}

async function encryptPrivatePayload(value, env) {
  const key = await urlEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  return { sourceCiphertext: bytesToBase64Url(new Uint8Array(ciphertext)), sourceIv: bytesToBase64Url(iv) };
}

async function decryptPrivatePayload(message, env) {
  const key = await urlEncryptionKey(env);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(message.sourceIv) }, key, base64UrlToBytes(message.sourceCiphertext));
  return JSON.parse(decoder.decode(plaintext));
}

async function urlEncryptionKey(env) {
  if (!env.URL_ENCRYPTION_KEY) throw new HttpError(503, "Downloaderの暗号化設定が未完了です。");
  const bytes = base64UrlToBytes(env.URL_ENCRYPTION_KEY);
  if (bytes.length !== 32) throw new HttpError(503, "Downloaderの暗号化設定を確認できません。");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function createInternalGrant(payload, env) {
  if (!env.INTERNAL_SIGNING_SECRET) throw new HttpError(503, "Downloaderの内部署名設定が未完了です。");
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, env.INTERNAL_SIGNING_SECRET)}`;
}

async function verifyInternalGrant(header, env) {
  if (!env.INTERNAL_SIGNING_SECRET || !String(header || "").startsWith("Bearer ")) return null;
  const token = String(header).slice(7);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  if (!(await safeEqual(signature, await hmac(payload, env.INTERNAL_SIGNING_SECRET)))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return value.expiresAt > nowSeconds() && /^[A-Za-z0-9_-]{1,128}$/.test(String(value.jobId || "")) &&
      /^[A-Za-z0-9_-]{1,128}$/.test(String(value.processingToken || "")) &&
      /^downloads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(value.objectKey) ? value : null;
  } catch { return null; }
}

async function signSession(payload, env) {
  if (!env.SESSION_SECRET) throw new HttpError(503, "Downloaderのセッション設定が未完了です。");
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, env.SESSION_SECRET)}`;
}

async function verifySession(token, env) {
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra || !(await safeEqual(signature, await hmac(payload, env.SESSION_SECRET)))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(payload)));
    return value.authMethod === "passkey" && value.identityId && value.serviceAccountId === "owner" &&
      Number(value.expiresAt) > nowSeconds() && String(value.sessionVersion) === String(env.SESSION_VERSION || "1") ? value : null;
  } catch { return null; }
}

async function audit(env, request, session, eventType, outcome, details = {}) {
  try {
    await env.SECURITY?.recordAuditEvent({
      service: "downloader", eventType, outcome, identityId: session.identityId,
      serviceLinkId: session.serviceLinkId, serviceAccountId: session.serviceAccountId,
      role: SESSION_ROLE, authMethod: "passkey", credentialId: session.credentialId,
      expiresAt: session.expiresAt, startedAt: session.startedAt, sessionVersion: session.sessionVersion,
      passkeySessionEpoch: session.passkeySessionEpoch,
      sessionIdHash: session.sessionId ? await hmac(session.sessionId, env.SESSION_SECRET || "downloader") : null,
      userAgent: request.headers.get("User-Agent"), details
    });
  } catch { /* authentication and cleanup do not depend on audit transport */ }
}

async function auditSystem(env, identityId, serviceLinkId, eventType, outcome, details) {
  try {
    await env.SECURITY?.recordAuditEvent({ service: "downloader", eventType, outcome, identityId, serviceLinkId, serviceAccountId: "owner", role: SESSION_ROLE, authMethod: "system", details });
  } catch { /* best effort */ }
}

function auditSource(url, urlHash, jobId) {
  return { jobId, hostname: url.hostname, urlHash };
}

async function serveAsset(request, env, url, path) {
  const assetPath = path === "/" ? "/" : path;
  const response = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", assetPath === "/" ? "no-store" : "no-cache");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireMutation(request, url) {
  if (request.headers.get("Origin") !== url.origin || !String(request.headers.get("Content-Type") || "").startsWith("application/json")) {
    throw new HttpError(403, "不正なリクエストです。");
  }
}

function ensureContainerConfigured(env) {
  if (!env.DOWNLOADER_CONTAINER) throw new HttpError(503, "Downloaderの隔離処理環境が利用できません。");
}
function ensureQueueConfigured(env) { if (!env.JOBS) throw new HttpError(503, "Downloaderの処理Queueが利用できません。"); }
function passkeysEnabled(env) { return String(env.PASSKEY_ENABLED || "false") === "true"; }
function maxFileBytes(env) { return clampNumber(env.MAX_FILE_BYTES, 1_048_576, MAX_FILE_BYTES, MAX_FILE_BYTES); }
function maxBytesForRow(env, row) { return String(row.extractor || "").toLowerCase().includes("twitter") && row.media_type === "audio" ? Math.min(maxFileBytes(env), clampNumber(env.MAX_SPACE_BYTES, 1_048_576, MAX_FILE_BYTES, MAX_SPACE_BYTES)) : maxFileBytes(env); }
function downloadTtl(env) { return clampNumber(env.DOWNLOAD_TTL_SECONDS, 60, DOWNLOAD_TTL_SECONDS, DOWNLOAD_TTL_SECONDS); }
async function releaseContainer(container) { try { await container.release(); } catch (error) { console.error(JSON.stringify({ event: "downloader_container_stop_failed", error: safeErrorName(error) })); } }
function safeQueueJobId(value) { const jobId = String(value || ""); return /^[A-Za-z0-9_-]{1,128}$/.test(jobId) ? jobId : null; }
function clearCookie(secure) { return `${SESSION_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
function contentDisposition(filename) { return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(sanitizeFilename(filename))}`; }
function parseCookies(header) { return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)]; })); }
function cleanText(value, max) { return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max); }
function cleanFormatSelector(value) { const text = cleanText(value, 256); return /^[A-Za-z0-9_+.,:/?*^$=!<>~()\[\]{} -]+$/.test(text) ? text : ""; }
function safeInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback; }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function sqliteUtcTimestamp(milliseconds) { return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 19); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function safeContainerMessage(value) { const text = cleanText(value, 240); return /^(この|URL|ファイル|コンテンツ|安全)/.test(text) ? text : "このURLからメディアを確認できませんでした。"; }
function userSafeError(error) { return error instanceof HttpError || error instanceof DomainError ? cleanText(error.message, 240) : "このURLからメディアを確認できませんでした。"; }
function queueErrorReason(error) {
  const code = cleanText(error?.message || error?.name || "unknown", 80);
  if (code.includes("scan") || code.includes("malware") || code.includes("yara")) return "安全性を確認できなかったため取得を中止しました。";
  if (code.includes("size")) return "ファイルサイズが上限を超えています。";
  if (code.includes("format_unavailable") || code.includes("manifest_invalid")) return "動画の配信形式を確認できませんでした。";
  if (code.includes("download_timeout") || code.includes("job_deadline_exceeded")) return "安全な処理時間を超えたため取得を中止しました。";
  return "ファイルを取得できませんでした。時間を置いてお試しください。";
}
function isAllowedExtractorPost(url) {
  const hostname = String(url?.hostname || "").toLowerCase();
  return (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) && url.pathname.startsWith("/youtubei/v1/");
}
function copyYoutubeExtractorHeader(source, target, name, pattern, maxLength) { const value = String(source.get(name) || "").slice(0, maxLength); if (pattern.test(value)) target.set(name, value); }
function decodeHeaderValue(value) { try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); } }
function scheduleAudit(context, promise) { if (context?.waitUntil) context.waitUntil(promise); else void promise.catch(() => {}); }
function scheduleUsage(context, promise) { if (context?.waitUntil) context.waitUntil(promise); else void promise.catch(() => {}); }
function safeErrorName(error) { return error instanceof Error ? `${cleanText(error.name, 60) || "Error"}:${cleanText(error.code, 60) || "unspecified"}` : "unknown"; }
function safeMetricHeader(value, maximum) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : 0; }
function normalizeNormalizationMode(value) { const mode = String(value || ""); return ["PASS_THROUGH", "REMUX", "PARTIAL_TRANSCODE", "FULL_TRANSCODE", "NOT_APPLICABLE"].includes(mode) ? mode : "UNKNOWN"; }

function containerResponseError(value, status) {
  const code = normalizeContainerErrorCode(value, status);
  const error = new Error(code);
  error.code = code;
  return error;
}
function json(value, status = 200, inputHeaders) { const headers = new Headers(inputHeaders); headers.set("Content-Type", "application/json; charset=utf-8"); headers.set("Cache-Control", "no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("X-Robots-Tag", "noindex, nofollow, noarchive"); return new Response(JSON.stringify(value), { status, headers }); }
async function readJson(request, max) { const size = Number(request.headers.get("Content-Length") || 0); if (size > max) throw new HttpError(413, "入力内容が大きすぎます。"); try { const value = await request.json(); return value && typeof value === "object" ? value : {}; } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); } }
async function hmac(value, secret) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
async function urlFingerprint(value, env) { if (!env.INTERNAL_SIGNING_SECRET) throw new HttpError(503, "Downloaderの内部署名設定が未完了です。"); return hmac(`downloader-url-v1\0${value}`, env.INTERNAL_SIGNING_SECRET); }
async function safeEqual(left, right) { let a; let b; try { a = base64UrlToBytes(left); b = base64UrlToBytes(right); } catch { return false; } if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i += 1) result |= a[i] ^ b[i]; return result === 0; }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlToBytes(value) { const text = String(value || ""); if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error("invalid base64url"); const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }

class HttpError extends Error {
  constructor(status, message, code = "request_failed") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}
