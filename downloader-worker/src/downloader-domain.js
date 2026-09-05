const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data.ec2.internal"
]);

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_SPACE_BYTES = 512 * 1024 * 1024;
export const DOWNLOAD_TTL_SECONDS = 12 * 60 * 60;
export const ORPHAN_OBJECT_GRACE_MS = 15 * 60 * 1000;
export const QUEUE_MAX_RETRIES = 3;

export function orphanObjectIsPastGrace(uploaded, nowMs = Date.now(), graceMs = ORPHAN_OBJECT_GRACE_MS) {
  const uploadedMs = uploaded instanceof Date ? uploaded.getTime() : new Date(uploaded).getTime();
  const currentMs = Number(nowMs);
  const minimumAgeMs = Number(graceMs);
  if (!Number.isFinite(uploadedMs) || !Number.isFinite(currentMs) || !Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
    return false;
  }
  return uploadedMs <= currentMs - minimumAgeMs;
}

export function isFinalQueueAttempt(attempts, maxRetries = QUEUE_MAX_RETRIES) {
  const attempt = Number(attempts);
  const retries = Number(maxRetries);
  return Number.isInteger(attempt) && Number.isInteger(retries) && attempt > retries;
}

export function queueRetryDelaySeconds(attempts) {
  const attempt = Number.isInteger(Number(attempts)) ? Math.max(1, Number(attempts)) : 1;
  return Math.min(300, 30 * (2 ** Math.max(0, attempt - 1)));
}

export class DomainError extends Error {
  constructor(status, message, code = "invalid_request") {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeSourceUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new DomainError(400, "URLを確認してください。", "invalid_url");
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    throw new DomainError(400, "HTTPまたはHTTPSのURLを入力してください。", "unsupported_scheme");
  }
  url.hash = "";
  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname) || isBlockedIpLiteral(hostname)) {
    throw new DomainError(403, "このURLは安全上の理由でアクセスできません。", "ssrf_blocked");
  }
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new DomainError(403, "このURLのポートにはアクセスできません。", "blocked_port");
  }
  if (url.href.length > 4096) throw new DomainError(413, "URLが長すぎます。", "url_too_long");
  return url;
}

export function normalizeHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isBlockedHostname(hostname) {
  const value = normalizeHostname(hostname);
  return !value || BLOCKED_HOSTS.has(value) || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal");
}

export function isBlockedIpLiteral(hostname) {
  const value = normalizeHostname(hostname);
  if (value.includes(":")) return isBlockedIpv6(value);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function isBlockedIpv6(value) {
  const text = value.toLowerCase().split("%")[0];
  if (text === "::" || text === "::1") return true;
  if (text.startsWith("fc") || text.startsWith("fd") || /^fe[89ab]/.test(text) || text.startsWith("ff")) return true;
  if (text.startsWith("2001:db8:")) return true;
  if (text.startsWith("::ffff:")) return true;
  const mapped = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped ? isBlockedIpLiteral(mapped[1]) : false;
}

export function sanitizeFilename(input, mimeType = "application/octet-stream") {
  const fallback = fallbackFilename(mimeType);
  const decoded = String(input || fallback).normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\.+/g, ".")
    .replace(/^\.+/, "")
    .trim();
  const value = decoded || fallback;
  const extension = value.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] || "";
  const base = value.slice(0, extension ? -extension.length : undefined).trim() || "download";
  return `${base.slice(0, Math.max(1, 120 - extension.length))}${extension.toLowerCase()}`;
}

function fallbackFilename(mimeType) {
  if (String(mimeType).startsWith("video/")) return "download.mp4";
  if (String(mimeType).startsWith("audio/")) return "download.m4a";
  if (String(mimeType).startsWith("image/")) return "download.jpg";
  return "download.bin";
}

export function normalizeClientRequestId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(text) ? text : "";
}

export function normalizeMediaId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.:@+-]{1,180}$/.test(text) ? text : "";
}

export function normalizeContainerErrorCode(value, status) {
  const code = String(value || "").trim();
  if (/^[a-z][a-z0-9_]{0,79}$/.test(code)) return code;
  const httpStatus = Number.isInteger(Number(status)) && Number(status) >= 100 && Number(status) <= 599
    ? Number(status)
    : 500;
  return `container_${httpStatus}`;
}

export function publicJob(row) {
  return {
    id: row.id,
    status: row.status,
    sourceHostname: row.source_hostname,
    sourcePathHint: null,
    extractor: row.extractor || null,
    mediaType: row.media_type || null,
    progressStage: row.status === "processing" && [
      "starting", "downloading", "validating", "processing", "scanning", "saving", "finalizing"
    ].includes(row.progress_stage) ? row.progress_stage : null,
    normalizationMode: row.normalization_mode || null,
    expectedSize: numberOrNull(row.expected_size),
    actualSize: numberOrNull(row.actual_size),
    mimeType: row.mime_type || null,
    sha256: row.sha256 || null,
    filename: row.safe_filename || null,
    analysis: publicAnalysis(parseJson(row.analysis_json, {})),
    error: row.error_reason || null,
    createdAt: utc(row.created_at),
    analyzedAt: utc(row.analyzed_at),
    downloadedAt: utc(row.downloaded_at),
    expiresAt: row.expires_at ? new Date(Number(row.expires_at) * 1000).toISOString() : null
  };
}

export function publicAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const { _sealedRoutes: _ignored, ...publicValue } = value;
  return publicValue;
}

export function exceedsVideoTranscodeBudget(media, budgetSeconds = 240) {
  const value = media && typeof media === "object" ? media : {};
  const videoCodec = String(value.videoCodec || "").toLowerCase();
  const h264Compatible = videoCodec === "h264" || videoCodec === "avc1" || videoCodec.startsWith("avc1.");
  const needsVideo = Boolean(videoCodec) && videoCodec !== "none" && !h264Compatible;
  if (!needsVideo || (value.mediaType && value.mediaType !== "video")) return false;
  const duration = Number(value.duration);
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const width = Math.max(320, Number(value.width) || 1920);
  const height = Math.max(240, Number(value.height) || 1080);
  const fps = Math.max(1, Number(value.fps) || 30);
  const equivalent1080p30Seconds = duration * ((width * height * fps) / (1920 * 1080 * 30));
  return equivalent1080p30Seconds > Math.max(30, Number(budgetSeconds) || 240);
}

export function isPolicyRestrictedHost(hostname) {
  const value = normalizeHostname(hostname);
  return value === "youtu.be" || value === "youtube.com" || value.endsWith(".youtube.com") ||
    value === "youtube-nocookie.com" || value.endsWith(".youtube-nocookie.com") ||
    value === "googlevideo.com" || value.endsWith(".googlevideo.com");
}

export function isPolicyRestrictedAnalysis(analysis) {
  const value = analysis && typeof analysis === "object" ? analysis : {};
  if ([value.hostname, value.finalHostname].some((hostname) => isPolicyRestrictedHost(hostname))) return true;
  const descriptor = `${String(value.site || "")} ${String(value.extractor || "")}`.toLowerCase();
  return descriptor.includes("youtube");
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function utc(value) {
  if (!value) return null;
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
