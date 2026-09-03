import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { sessionCookieValue, sessionPolicyForAuthMethod } from "../../assets/session-policy.mjs";
import {
  DomainError,
  DOWNLOAD_TTL_SECONDS,
  MAX_FILE_BYTES,
  MAX_SPACE_BYTES,
  QUEUE_MAX_RETRIES,
  isFinalQueueAttempt,
  isPolicyRestrictedAnalysis,
  isPolicyRestrictedHost,
  normalizeClientRequestId,
  normalizeMediaId,
  normalizeSourceUrl,
  publicJob,
  queueRetryDelaySeconds,
  sanitizeFilename,
  sha256Text,
  sourcePathHint
} from "./downloader-domain.js";

export { ContainerProxy };

const BASE_PATH = "/downloader";
const SESSION_COOKIE = "troom_downloader_session";
const SESSION_ROLE = "owner";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PRIVATE_DESTINATIONS = Object.freeze([
  "localhost", "*.localhost", "metadata.google.internal", "metadata.aws.internal", "instance-data.ec2.internal",
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32"
]);

export class DownloaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  interceptHttps = true;
  deniedHosts = [...PRIVATE_DESTINATIONS];

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
  "r2.tlain.internal": async (request, env, ctx) => handleContainerUpload(request, env, ctx)
};

DownloaderContainer.outbound = async (request) => {
  try {
    const url = normalizeSourceUrl(request.url);
    if (!["GET", "HEAD", "POST"].includes(request.method)) return new Response("Method Not Allowed", { status: 405 });
    const headers = new Headers(request.headers);
    headers.delete("Proxy-Authorization");
    headers.delete("Cookie");
    headers.delete("Authorization");
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
    await cleanupExpiredJobs(this.env);
  }
}

export async function handleQueueBatch(batch, env) {
  for (const message of batch.messages) {
    try {
      const body = message.body || {};
      if (body.type === "download") await processDownloadMessage(env, body);
      else if (body.type === "delete") await deleteJobObject(env, String(body.jobId || ""), "expired");
      message.ack();
    } catch (error) {
      const terminalAttempt = isFinalQueueAttempt(message.attempts, QUEUE_MAX_RETRIES);
      console.error(JSON.stringify({
        event: "downloader_queue_failed",
        jobId: safeQueueJobId(message.body?.jobId),
        error: safeErrorName(error),
        attempts: message.attempts,
        terminalAttempt
      }));
      if (terminalAttempt && message.body?.type === "download") {
        try {
          await markDownloadFailed(env, message.body, error);
        } catch (markError) {
          console.error(JSON.stringify({ event: "downloader_queue_failure_status_update_failed", error: safeErrorName(markError) }));
        }
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
  if (path === "/api/session" && request.method === "GET") {
    scheduleAudit(context, audit(env, request, session, "session_resume", "success"));
    return json({ authenticated: true, user: { displayName: session.displayName, role: SESSION_ROLE } });
  }
  if (path === "/api/logout" && request.method === "POST") {
    requireMutation(request, url);
    scheduleAudit(context, audit(env, request, session, "logout", "success"));
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(url.protocol === "https:") });
  }
  if (path === "/api/jobs" && request.method === "GET") return listJobs(env, session);
  if (path === "/api/analyze" && request.method === "POST") {
    requireMutation(request, url);
    return analyzeSource(request, env, session);
  }

  const jobMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/);
  if (jobMatch && request.method === "GET") return getJob(env, session, jobMatch[1]);
  const downloadMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/download$/);
  if (downloadMatch && request.method === "POST") {
    requireMutation(request, url);
    return requestDownload(request, env, session, downloadMatch[1]);
  }
  const fileMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})\/file$/);
  if (fileMatch && request.method === "GET") return serveDownload(env, session, fileMatch[1]);
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
  return json({ authenticated: true, displayName: payload.displayName }, 200, {
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
  const body = await readJson(request, 8192);
  const sourceUrl = normalizeSourceUrl(body.url);
  const clientRequestId = normalizeClientRequestId(body.clientRequestId);
  if (!clientRequestId) throw new HttpError(400, "解析リクエストを確認してください。");
  await enforceRateLimit(env, session.identityId, sourceUrl.hostname, "analyze", 30, 10);
  const hash = await sha256Text(sourceUrl.href);
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
      .bind(jobId, session.identityId, session.serviceLinkId, clientRequestId, sourceUrl.hostname, sourcePathHint(sourceUrl), hash),
    rateEventStatement(env, session.identityId, sourceUrl.hostname, "analyze")
  ]);
  await audit(env, request, session, "downloader_analyze_requested", "success", auditSource(sourceUrl, hash, jobId));

  const container = getContainer(env.DOWNLOADER_CONTAINER, "analysis");
  try {
    const response = await container.fetch(new Request("http://container/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: sourceUrl.href, maxBytes: maxFileBytes(env), policyRestricted: isPolicyRestrictedHost(sourceUrl.hostname) }),
      signal: AbortSignal.timeout(120_000)
    }));
    const analysis = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(response.status >= 500 ? 503 : response.status, safeContainerMessage(analysis.error));
    const normalized = normalizeAnalysis(analysis, sourceUrl.hostname);
    const extractor = String(normalized.extractor || "unknown").slice(0, 80);
    const mediaType = String(normalized.media?.[0]?.mediaType || "unknown").slice(0, 40);
    const deliveryType = String(normalized.media?.[0]?.delivery || "unknown").slice(0, 40);
    await env.DB.prepare(`UPDATE downloader_jobs SET status = 'analyzed', extractor = ?, media_type = ?, delivery_type = ?, analysis_json = ?,
      analyzed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ? AND status = 'analyzing'`)
      .bind(extractor, mediaType, deliveryType, JSON.stringify(normalized), jobId, session.identityId).run();
    const row = await ownedJob(env, session.identityId, jobId);
    await audit(env, request, session, "downloader_analyze_completed", "success", { ...auditSource(sourceUrl, hash, jobId), extractor, mediaCount: normalized.media.length });
    return json({ job: publicJob(row) }, 201);
  } catch (error) {
    await env.DB.prepare(`UPDATE downloader_jobs SET status = 'failed', error_type = 'analyze_failed', error_reason = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ? AND status = 'analyzing'`)
      .bind(userSafeError(error), jobId, session.identityId).run();
    await audit(env, request, session, error?.code === "ssrf_blocked" ? "downloader_ssrf_blocked" : "downloader_analyze_failed", "failure", auditSource(sourceUrl, hash, jobId));
    throw error;
  } finally {
    await releaseContainer(container);
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
  if (row.url_hash !== await sha256Text(sourceUrl.href)) throw new HttpError(409, "解析時と同じURLを入力してください。");
  const analysis = parseJson(row.analysis_json, {});
  if (isPolicyRestrictedHost(sourceUrl.hostname) || isPolicyRestrictedAnalysis(analysis)) {
    throw new HttpError(451, "YouTubeの利用規約により、このサービスから本体を取得できません。YouTube公式の保存機能をご利用ください。", "policy_restricted");
  }
  if (row.status === "processing" || row.status === "ready") return json({ job: publicJob(row) });
  if (row.status === "queued") {
    const encrypted = await encryptQueueUrl(sourceUrl.href, env);
    await env.JOBS.send({ type: "download", jobId, identityId: session.identityId, mediaId: row.selected_media_id || mediaId, ...encrypted });
    return json({ job: publicJob(row) }, 202);
  }
  if (row.status !== "analyzed") throw new HttpError(409, "この解析結果から取得を開始できません。");
  const selected = (analysis.media || []).find((item) => item.mediaId === mediaId);
  if (!selected || selected.downloadable !== true || selected.drm === true || selected.loginRequired === true) {
    throw new HttpError(409, selected?.unavailableReason || "このメディアは取得できません。");
  }
  await enforceRateLimit(env, session.identityId, sourceUrl.hostname, "download", 5, 5);
  const inFlight = await env.DB.prepare(`SELECT 1 AS ok FROM downloader_jobs
    WHERE identity_id = ? AND id != ? AND status IN ('queued', 'processing') LIMIT 1`).bind(session.identityId, jobId).first();
  if (inFlight) throw new HttpError(429, "現在の取得が完了してから、次の取得を開始してください。");
  const encrypted = await encryptQueueUrl(sourceUrl.href, env);
  const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'queued', selected_media_id = ?, expected_size = ?,
    queued_at = CURRENT_TIMESTAMP, error_type = NULL, error_reason = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND status = 'analyzed'`)
    .bind(mediaId, safeInteger(selected.estimatedSize), jobId, session.identityId).run();
  if (!update.meta?.changes) throw new HttpError(409, "取得状態が更新されています。画面を再読み込みしてください。");
  await env.DB.batch([rateEventStatement(env, session.identityId, sourceUrl.hostname, "download")]);
  await env.JOBS.send({ type: "download", jobId, identityId: session.identityId, mediaId, ...encrypted });
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
  const leaseExpiresAt = nowSeconds() + clampNumber(env.PROCESS_TIMEOUT_SECONDS, 60, 720, 720) + 60;
  const claim = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'processing', processing_at = COALESCE(processing_at, CURRENT_TIMESTAMP),
    processing_token = ?, processing_lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND (
      status = 'queued' OR (status = 'processing' AND (processing_lease_expires_at IS NULL OR processing_lease_expires_at <= ?))
    )`).bind(processingToken, leaseExpiresAt, jobId, identityId, nowSeconds()).run();
  if (!claim.meta?.changes) return;
  await auditSystem(env, identityId, row.service_link_id, "downloader_download_started", "success", { jobId, hostname: row.source_hostname });
  try {
    const sourceUrl = normalizeSourceUrl(await decryptQueueUrl(message, env));
    if (await sha256Text(sourceUrl.href) !== row.url_hash) throw new Error("url_hash_mismatch");
    const objectKey = `downloads/${jobId}/${crypto.randomUUID()}`;
    const expiresAt = nowSeconds() + downloadTtl(env);
    const grant = await createInternalGrant({ jobId, identityId, processingToken, objectKey, expiresAt, maxBytes: maxBytesForRow(env, row) }, env);
    const container = getContainer(env.DOWNLOADER_CONTAINER, `job-${jobId}`);
    try {
      const response = await container.fetch(new Request("http://container/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: sourceUrl.href,
          mediaId: String(message.mediaId || row.selected_media_id || ""),
          jobId,
          identityId,
          objectKey,
          uploadGrant: grant,
          maxBytes: maxBytesForRow(env, row),
          timeoutSeconds: clampNumber(env.PROCESS_TIMEOUT_SECONDS, 60, 720, 720)
        }),
        signal: AbortSignal.timeout((clampNumber(env.PROCESS_TIMEOUT_SECONDS, 60, 720, 720) + 30) * 1000)
      }));
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result.errorCode || `container_${response.status}`));
      const normalization = ["PASS_THROUGH", "REMUX", "PARTIAL_TRANSCODE", "FULL_TRANSCODE", "NOT_APPLICABLE"].includes(result.normalization)
        ? result.normalization : "UNKNOWN";
      await env.DB.prepare(`UPDATE downloader_jobs SET normalization_mode = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND identity_id = ? AND status = 'ready'`).bind(normalization, jobId, identityId).run();
      const ready = await env.DB.prepare("SELECT status FROM downloader_jobs WHERE id = ? AND identity_id = ?").bind(jobId, identityId).first();
      if (ready?.status !== "ready") throw new Error("container_upload_not_committed");
      await auditSystem(env, identityId, row.service_link_id, "downloader_scan_passed", "success", { jobId, hostname: row.source_hostname });
      await auditSystem(env, identityId, row.service_link_id, "downloader_download_completed", "success", { jobId, hostname: row.source_hostname, actualSize: result.actualSize || null });
    } finally {
      await releaseContainer(container);
    }
  } catch (error) {
    await env.DB.prepare(`UPDATE downloader_jobs SET processing_token = NULL, processing_lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ? AND status = 'processing' AND processing_token = ?`)
      .bind(jobId, identityId, processingToken).run();
    throw error;
  }
}

async function markDownloadFailed(env, message, error) {
  const jobId = String(message?.jobId || "");
  const identityId = String(message?.identityId || "");
  const row = await env.DB.prepare("SELECT service_link_id, source_hostname FROM downloader_jobs WHERE id = ? AND identity_id = ?")
    .bind(jobId, identityId).first();
  if (!row) return;
  const safe = queueErrorReason(error);
  const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'failed', error_type = 'download_failed', error_reason = ?,
    processing_token = NULL, processing_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND identity_id = ? AND status IN ('queued', 'processing')`)
    .bind(safe, jobId, identityId).run();
  if (update.meta?.changes) await auditSystem(env, identityId, row.service_link_id, "downloader_download_failed", "failure", { jobId, hostname: row.source_hostname, reason: safe });
}

async function handleContainerUpload(request, env) {
  if (request.method !== "PUT") return new Response("Method Not Allowed", { status: 405 });
  const grant = await verifyInternalGrant(request.headers.get("Authorization"), env);
  if (!grant) return new Response("Unauthorized", { status: 401 });
  const size = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isSafeInteger(size) || size <= 0 || size > grant.maxBytes) return new Response("Payload Too Large", { status: 413 });
  const row = await env.DB.prepare(`SELECT status FROM downloader_jobs
    WHERE id = ? AND identity_id = ? AND status = 'processing' AND processing_token = ? AND processing_lease_expires_at > ?`)
    .bind(grant.jobId, grant.identityId, grant.processingToken, nowSeconds()).first();
  if (!row) return new Response("Conflict", { status: 409 });
  const sha256 = String(request.headers.get("X-Content-SHA256") || "").toLowerCase();
  const mimeType = String(request.headers.get("Content-Type") || "application/octet-stream").slice(0, 120);
  const filename = sanitizeFilename(decodeHeaderValue(request.headers.get("X-Filename")), mimeType);
  if (!/^[a-f0-9]{64}$/.test(sha256)) return new Response("Invalid digest", { status: 400 });
  console.log(JSON.stringify({ event: "downloader_container_upload_received", jobId: grant.jobId, size }));
  let committed = false;
  try {
    await env.DOWNLOADS.put(grant.objectKey, request.body, {
      httpMetadata: { contentType: mimeType, contentDisposition: contentDisposition(filename) },
      customMetadata: { jobId: grant.jobId, processingToken: grant.processingToken, sha256 }
    });
    const update = await env.DB.prepare(`UPDATE downloader_jobs SET status = 'ready', object_key = ?, actual_size = ?, sha256 = ?,
      mime_type = ?, safe_filename = ?, downloaded_at = CURRENT_TIMESTAMP, expires_at = ?, processing_token = NULL,
      processing_lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND identity_id = ? AND status = 'processing' AND processing_token = ?`)
      .bind(grant.objectKey, size, sha256, mimeType, filename, grant.expiresAt, grant.jobId, grant.identityId, grant.processingToken).run();
    committed = update.meta?.changes === 1;
  } finally {
    if (!committed) await env.DOWNLOADS.delete(grant.objectKey);
  }
  if (!committed) {
    return new Response("Conflict", { status: 409 });
  }
  console.log(JSON.stringify({ event: "downloader_container_upload_committed", jobId: grant.jobId, size }));
  await env.JOBS.send({ type: "delete", jobId: grant.jobId }, { delaySeconds: Math.max(1, grant.expiresAt - nowSeconds()) });
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

async function serveDownload(env, session, jobId) {
  const row = await ownedJob(env, session.identityId, jobId);
  if (row.status !== "ready" || !row.object_key) throw new HttpError(409, "ファイルはまだダウンロードできません。");
  if (Number(row.expires_at || 0) <= nowSeconds()) {
    await deleteJobObject(env, jobId, "expired");
    throw new HttpError(410, "ファイルの保存期限が終了しました。");
  }
  const object = await env.DOWNLOADS.get(row.object_key);
  if (!object) {
    await env.DB.prepare(`UPDATE downloader_jobs SET status = 'expired', error_type = 'object_missing',
      error_reason = 'ファイルの保存期限が終了しました。', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(jobId).run();
    throw new HttpError(410, "ファイルの保存期限が終了しました。");
  }
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
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(finalStatus === "expired" ? "expired" : "deleted", jobId).run();
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
      error_reason = '処理が完了しなかったため終了しました。', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run();
  }
  await cleanupOrphanObjects(env);
  await env.DB.prepare("DELETE FROM downloader_rate_events WHERE occurred_at < ?")
    .bind(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()).run();
}

async function cleanupOrphanObjects(env) {
  let cursor;
  let pages = 0;
  do {
    const listed = await env.DOWNLOADS.list({ prefix: "downloads/", cursor, limit: 250, include: ["customMetadata"] });
    for (const object of listed.objects || []) {
      const jobId = String(object.customMetadata?.jobId || object.key.split("/")[1] || "");
      const row = jobId ? await env.DB.prepare("SELECT object_key, status, expires_at, processing_token, processing_lease_expires_at FROM downloader_jobs WHERE id = ?").bind(jobId).first() : null;
      const current = row?.status === "ready" && row.object_key === object.key && Number(row.expires_at || 0) > nowSeconds();
      const uploading = row?.status === "processing" && row.processing_token === object.customMetadata?.processingToken &&
        Number(row.processing_lease_expires_at || 0) > nowSeconds();
      if (!current && !uploading) await env.DOWNLOADS.delete(object.key);
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

function normalizeAnalysis(input, hostname) {
  const media = (Array.isArray(input.media) ? input.media : []).slice(0, 50).map((item, index) => ({
    mediaId: normalizeMediaId(item.mediaId) || `media-${index + 1}`,
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
    downloadable: item.downloadable === true,
    unavailableReason: cleanText(item.unavailableReason, 240) || null,
    normalization: cleanText(item.normalization, 40) || (item.mediaType === "video" ? "AUTO" : "NOT_APPLICABLE")
  }));
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
    media
  };
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

async function encryptQueueUrl(url, env) {
  const key = await urlEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(url));
  return { sourceCiphertext: bytesToBase64Url(new Uint8Array(ciphertext)), sourceIv: bytesToBase64Url(iv) };
}

async function decryptQueueUrl(message, env) {
  const key = await urlEncryptionKey(env);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(message.sourceIv) }, key, base64UrlToBytes(message.sourceCiphertext));
  return decoder.decode(plaintext);
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
    return value.expiresAt > nowSeconds() && /^[A-Za-z0-9_-]{1,128}$/.test(String(value.processingToken || "")) &&
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
  return { jobId, hostname: url.hostname, pathHint: sourcePathHint(url), urlHash };
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
function safeInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback; }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function sqliteUtcTimestamp(milliseconds) { return new Date(milliseconds).toISOString().replace("T", " ").slice(0, 19); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function safeContainerMessage(value) { const text = cleanText(value, 240); return /^(この|URL|ファイル|コンテンツ|安全)/.test(text) ? text : "このURLからメディアを確認できませんでした。"; }
function userSafeError(error) { return error instanceof HttpError || error instanceof DomainError ? cleanText(error.message, 240) : "このURLからメディアを確認できませんでした。"; }
function queueErrorReason(error) { const code = cleanText(error?.message || error?.name || "unknown", 80); return code.includes("scan") ? "安全性を確認できなかったため取得を中止しました。" : code.includes("size") ? "ファイルサイズが上限を超えています。" : "ファイルを取得できませんでした。時間を置いてお試しください。"; }
function decodeHeaderValue(value) { try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); } }
function scheduleAudit(context, promise) { if (context?.waitUntil) context.waitUntil(promise); else void promise.catch(() => {}); }
function safeErrorName(error) { return error instanceof Error ? `${error.name}:${cleanText(error.message, 120)}` : "unknown"; }
function json(value, status = 200, inputHeaders) { const headers = new Headers(inputHeaders); headers.set("Content-Type", "application/json; charset=utf-8"); headers.set("Cache-Control", "no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("X-Robots-Tag", "noindex, nofollow, noarchive"); return new Response(JSON.stringify(value), { status, headers }); }
async function readJson(request, max) { const size = Number(request.headers.get("Content-Length") || 0); if (size > max) throw new HttpError(413, "入力内容が大きすぎます。"); try { const value = await request.json(); return value && typeof value === "object" ? value : {}; } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); } }
async function hmac(value, secret) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
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
