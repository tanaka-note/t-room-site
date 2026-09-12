(function (global) {
  "use strict";
  // UI glyphs are paths so their shape and colour do not depend on an emoji font.
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
    folder: '<path d="M3 7V5h7l2 3h9v12H3z"/>',
    locked: '<path d="M3 7V5h7l2 3h9v12H3z"/><rect x="9" y="13" width="6" height="5" rx="1"/><path d="M10 13v-2a2 2 0 0 1 4 0v2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
    video: '<path d="m8 4 13 8-13 8z"/>',
    audio: '<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
    document: '<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6"/>',
    other: '<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',
    warning: '<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',
    share: '<path d="M13 4h7v7M20 4 10 14M9 5H4v15h15v-5"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    account: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    left: '<path d="m15 4-8 8 8 8"/>',
    right: '<path d="m9 4 8 8-8 8"/>',
    back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
    down: '<path d="m5 9 7 7 7-7"/>',
    up: '<path d="m5 15 7-7 7 7"/>',
    repeat: '<path d="M20 7v5h-5M20 12a8 8 0 1 0-2 6"/>',
    logout: '<path d="M10 3H4v18h6M10 12h11M16 7l5 5-5 5"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
  };
  function icon(name) {
    return `<svg class="ui-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.other}</svg>`;
  }
  // Do not insert a broken image or cache a blob until the browser decoded it.
  async function decodeThumbnail(blob, signal) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.alt = "";
    image.decoding = "async";
    try {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          image.onload = image.onerror = null;
          error ? reject(error) : resolve();
        };
        const abort = () => finish(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(() => finish(Object.assign(new Error("Thumbnail decode timeout"), {thumbnailTransient: true})), 10000);
        image.onload = () => finish(image.naturalWidth ? null : new Error("Empty thumbnail"));
        image.onerror = () => finish(new Error("Invalid thumbnail"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else image.src = url;
      });
      return { image, url };
    } catch (error) {
      image.src = "";
      URL.revokeObjectURL(url);
      throw error;
    }
  }
  const thumbnailTimings = [];
  async function measureThumbnailStep(step, operation) {
    if (global.TCLOUD_THUMBNAIL_DEBUG !== true) return operation();
    const started = performance.now();
    try { return await operation(); }
    finally {
      thumbnailTimings.push({step, milliseconds: performance.now() - started});
      if (thumbnailTimings.length > 256) thumbnailTimings.shift();
    }
  }
  // Opt-in, bounded, memory-only diagnostics. No names, keys, images or network telemetry.
  function highlightText(element, value, query) {
    const text = String(value || ""), term = String(query || "").trim();
    element.replaceChildren();
    if (!term) { element.textContent = text; return; }
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      element.append(document.createTextNode(text.slice(offset, match.index)));
      const mark = document.createElement("mark"); mark.textContent = match[0]; element.append(mark);
      offset = match.index + match[0].length;
    }
    element.append(document.createTextNode(text.slice(offset)));
  }
  function isBlankVideoFrame(source) {
    // A candidate for trying a later frame, not proof of corruption. Tiny local sample only.
    try {
      const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 18;
      const context = canvas.getContext("2d", {willReadFrequently:true});
      context.drawImage(source, 0, 0, 32, 18);
      const data = context.getImageData(0, 0, 32, 18).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.max(data[i],data[i+1],data[i+2]) <= 12) dark++;
      return dark / (32 * 18) >= .998;
    } catch { return false; }
  }
  async function recoverVideoThumbnail(url, signal) {
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "metadata";
    const wait = (event, action) => new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener("error", failed); signal?.removeEventListener("abort", aborted); };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Video frame unavailable")); };
      const aborted = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(failed, 12000);
      video.addEventListener(event, done, {once:true}); video.addEventListener("error", failed, {once:true});
      signal?.addEventListener("abort", aborted, {once:true});
      if (signal?.aborted) { aborted(); return; }
      try { action(); } catch { failed(); }
    });
    try {
      await wait("loadedmetadata", () => { video.src = url; video.load(); });
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= .2) return null;
      // Only two bounded seeks. The source is the existing device-local decrypted Range URL.
      for (const time of new Set([Math.min(10,duration*.25), Math.min(30,duration*.5)])) {
        await wait("seeked", () => { video.currentTime = time; });
        if (!video.videoWidth || !video.videoHeight || video.readyState < 2 || isBlankVideoFrame(video)) continue;
        const canvas = document.createElement("canvas"), scale = Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
        canvas.width = Math.max(1,Math.round(video.videoWidth*scale)); canvas.height = Math.max(1,Math.round(video.videoHeight*scale));
        canvas.getContext("2d",{alpha:false}).drawImage(video,0,0,canvas.width,canvas.height);
        return await new Promise(resolve => canvas.toBlob(resolve,"image/webp",.78));
      }
      return null;
    } finally { video.removeAttribute("src"); video.load(); }
  }
  global.TCloudUI = Object.freeze({ icon, decodeThumbnail, measureThumbnailStep, highlightText, isBlankVideoFrame, recoverVideoThumbnail,
    thumbnailTimings: () => thumbnailTimings.map(entry => ({...entry})),
    clearThumbnailTimings: () => { thumbnailTimings.length = 0; } });
})(globalThis);
