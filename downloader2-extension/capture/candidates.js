const MEDIA_TYPES = [
  "application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml"
];
const MANIFEST_EXTENSIONS = new Set(["m3u8", "mpd"]);
const DIRECT_EXTENSIONS = new Set(["mp4", "m4v", "webm", "m4a"]);
const SEGMENT_EXTENSIONS = new Set(["m4s", "ts", "aac"]);
const DRM_MARKERS = ["widevine", "playready", "com.widevine.alpha", "edef8ba9", "9a04f079"];

export function classifyObservation(input) {
  let url;
  try { url = new URL(input.url); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const contentType = String(input.contentType || "").split(";", 1)[0].trim().toLowerCase();
  const extension = extensionOf(url.pathname);
  const byType = MEDIA_TYPES.includes(contentType) || contentType.startsWith("video/") || contentType.startsWith("audio/");
  const byExtension = MANIFEST_EXTENSIONS.has(extension) || DIRECT_EXTENSIONS.has(extension) || SEGMENT_EXTENSIONS.has(extension);
  if (!byType && !byExtension) return null;
  if (Number(input.status || 0) >= 400) return null;
  // Segments are observed but never promoted to a selectable download. The
  // manifest/direct response is the stable candidate; exposing every segment
  // creates a storm and produces incomplete files.
  if (SEGMENT_EXTENSIONS.has(extension)) return null;

  const kind = contentType.includes("mpegurl") || extension === "m3u8" ? "hls"
    : contentType === "application/dash+xml" || extension === "mpd" ? "dash"
      : "direct";
  const drmText = `${url.pathname} ${input.drmSystem || ""}`.toLowerCase();
  const drm = DRM_MARKERS.some((marker) => drmText.includes(marker));
  const key = `${kind}:${url.origin}${url.pathname}`;
  return {
    id: stableId(key), key, url: url.href, hostname: url.hostname, kind,
    label: kind === "hls" ? "HLSストリーム" : kind === "dash" ? "DASHストリーム" : directLabel(contentType, extension),
    contentType: contentType || null, status: Number(input.status || 0) || null,
    resourceType: input.resourceType || null, source: input.source || "webRequest",
    priority: kind === "hls" || kind === "dash" ? 100 : extension === "mp4" ? 80 : 60,
    drm, requestContext: input.requestContext || { method: "GET", headers: {}, initiator: null }
  };
}

export function mergeCandidate(existing, incoming) {
  if (!existing) return incoming;
  return {
    ...existing, ...incoming,
    requestContext: {
      ...existing.requestContext, ...incoming.requestContext,
      headers: { ...(existing.requestContext?.headers || {}), ...(incoming.requestContext?.headers || {}) }
    },
    priority: Math.max(existing.priority || 0, incoming.priority || 0),
    drm: Boolean(existing.drm || incoming.drm)
  };
}

function extensionOf(pathname) {
  const match = String(pathname || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match?.[1] || "";
}

function directLabel(contentType, extension) {
  if (contentType.startsWith("audio/") || ["m4a", "aac"].includes(extension)) return "音声メディア";
  return "動画メディア";
}

function stableId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `media-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
