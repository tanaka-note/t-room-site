(function (global) {
  "use strict";

  const SNIFF_BYTES = 16 * 1024;
  const CACHE_LIMIT = 128;
  const detectionCache = new Map();
  const MIME_BY_CONTAINER = Object.freeze({
    mp4: "video/mp4",
    quicktime: "video/quicktime",
    webm: "video/webm",
    matroska: "video/x-matroska",
    flv: "video/x-flv",
    "mpeg-ts": "video/mp2t",
    "mpeg-ps": "video/mpeg",
    avi: "video/x-msvideo",
    asf: "video/x-ms-asf",
    ogg: "video/ogg"
  });
  const UNKNOWN = Object.freeze({ container: "unknown", mimeType: "application/octet-stream" });

  function detectContainer(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (bytes.length < 4) return UNKNOWN;
    if (ascii(bytes, 0, 3) === "FLV" && bytes[3] === 1) return result("flv");
    if (matches(bytes, 0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])) return result("asf");
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "AVI ") return result("avi");
    if (ascii(bytes, 0, 4) === "OggS") return result("ogg");
    if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
      const header = asciiLower(bytes, 0, Math.min(bytes.length, 8192));
      return result(header.includes("webm") ? "webm" : "matroska");
    }
    const iso = isoBmffContainer(bytes);
    if (iso) return iso;
    const transport = mpegTransportContainer(bytes);
    if (transport) return result("mpeg-ts");
    if (matches(bytes, 0, [0x00, 0x00, 0x01, 0xba]) || matches(bytes, 0, [0x00, 0x00, 0x01, 0xb3])) return result("mpeg-ps");
    return UNKNOWN;
  }

  async function detectBlob(blob) {
    if (!blob || typeof blob.slice !== "function") return UNKNOWN;
    const bytes = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
    try { return detectContainer(bytes); }
    finally { bytes.fill(0); }
  }

  async function detectFromUrl(url, file = {}) {
    const source = new URL(url, global.location?.href || "https://local.invalid/");
    if (global.location && (source.origin !== global.location.origin || !source.pathname.startsWith("/cloud/local-media/"))) {
      throw new Error("動画形式の確認先が端末内メディア経路ではありません。");
    }
    const key = detectionCacheKey(source, file);
    if (detectionCache.has(key)) return detectionCache.get(key);
    const task = (async () => {
      const response = await global.fetch(source.href, {
        headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` },
        credentials: "same-origin",
        cache: "no-store"
      });
      if (response.status !== 206) throw new Error("動画形式を必要最小限の範囲で確認できませんでした。");
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
      if (!contentRange || Number(contentRange[1]) !== 0 || Number(contentRange[2]) >= SNIFF_BYTES) {
        throw new Error("動画形式の確認範囲が不正です。");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      try {
        if (bytes.byteLength !== Number(contentRange[2]) + 1 || bytes.byteLength > SNIFF_BYTES) throw new Error("動画形式の確認データが不正です。");
        return detectContainer(bytes);
      } finally { bytes.fill(0); }
    })();
    detectionCache.set(key, task);
    trimCache();
    try { return await task; }
    catch (error) { detectionCache.delete(key); throw error; }
  }

  function playbackMimeType(file) {
    const container = normalizeContainer(file?.containerType);
    if (container) return mimeTypeForContainer(container);
    const declared = String(file?.mimeType || file?.type || "").trim().toLowerCase();
    const extension = extensionOf(file?.name);
    const legacy = {
      mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
      flv: "video/x-flv", ts: "video/mp2t", m2ts: "video/mp2t", mts: "video/mp2t",
      mp3: "audio/mpeg", m4a: "audio/mp4"
    }[extension];
    return legacy || declared || "application/octet-stream";
  }

  function mpegContainerType(file) {
    const container = normalizeContainer(file?.containerType);
    if (container) return container === "flv" ? "flv" : container === "mpeg-ts" ? "m2ts" : "";
    const extension = extensionOf(file?.name ?? file);
    if (extension === "flv") return "flv";
    if (["ts", "m2ts", "mts"].includes(extension)) return "m2ts";
    return "";
  }

  function legacyContainerType(file) {
    return ({
      mp4: "mp4", m4v: "mp4", m4a: "mp4", mov: "quicktime", webm: "webm", mkv: "matroska",
      flv: "flv", ts: "mpeg-ts", m2ts: "mpeg-ts", mts: "mpeg-ts", mpg: "mpeg-ps", mpeg: "mpeg-ps",
      avi: "avi", wmv: "asf", asf: "asf", ogg: "ogg"
    })[extensionOf(file?.name ?? file)] || "";
  }

  function normalizeContainer(value) {
    const container = String(value || "").trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(MIME_BY_CONTAINER, container) ? container : "";
  }

  function mimeTypeForContainer(value) {
    return MIME_BY_CONTAINER[normalizeContainer(value)] || "application/octet-stream";
  }

  function isoBmffContainer(bytes) {
    let offset = 0;
    const limit = Math.min(bytes.length, 256);
    while (offset + 12 <= limit) {
      const size = readUint32(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      if (type === "ftyp") {
        const brand = ascii(bytes, offset + 8, 4);
        if (["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return UNKNOWN;
        return result(brand === "qt  " ? "quicktime" : "mp4");
      }
      if (size < 8 || offset + size > limit) break;
      offset += size;
    }
    return null;
  }

  function mpegTransportContainer(bytes) {
    for (const stride of [188, 192, 204]) {
      const prefix = stride === 192 ? 4 : 0;
      for (let offset = 0; offset < stride && offset + prefix + stride * 2 < bytes.length; offset += 1) {
        if (bytes[offset + prefix] === 0x47 && bytes[offset + prefix + stride] === 0x47 && bytes[offset + prefix + stride * 2] === 0x47) return true;
      }
    }
    return false;
  }

  function detectionCacheKey(source, file) {
    let session = "";
    try { session = String(global.TCloudSession?.check?.()?.sessionCacheId || ""); } catch {}
    return JSON.stringify([
      session,
      String(file?.offlineAccountScope || ""),
      Number(file?.id || 0),
      String(file?.updatedAt || file?.createdAt || "1"),
      Number(file?.sizeBytes || file?.size || 0),
      session && Number(file?.id || 0) ? "" : source.pathname
    ]);
  }

  function trimCache() {
    while (detectionCache.size > CACHE_LIMIT) detectionCache.delete(detectionCache.keys().next().value);
  }

  function result(container) {
    return Object.freeze({ container, mimeType: MIME_BY_CONTAINER[container] });
  }

  function extensionOf(value) {
    const name = String(value || "");
    const index = name.lastIndexOf(".");
    return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
  }

  function matches(bytes, offset, values) {
    return offset + values.length <= bytes.length && values.every((value, index) => bytes[offset + index] === value);
  }

  function ascii(bytes, offset, length) {
    if (offset < 0 || offset + length > bytes.length) return "";
    return String.fromCharCode(...bytes.subarray(offset, offset + length));
  }

  function asciiLower(bytes, offset, length) {
    let value = "";
    for (const byte of bytes.subarray(offset, offset + length)) value += byte >= 32 && byte <= 126 ? String.fromCharCode(byte).toLowerCase() : " ";
    return value;
  }

  function readUint32(bytes, offset) {
    if (offset + 4 > bytes.length) return 0;
    return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
  }

  global.TCloudMediaFormat = Object.freeze({
    SNIFF_BYTES,
    detectContainer,
    detectBlob,
    detectFromUrl,
    playbackMimeType,
    mpegContainerType,
    legacyContainerType,
    normalizeContainer,
    mimeTypeForContainer,
    clearCache: () => detectionCache.clear()
  });
})(globalThis);
