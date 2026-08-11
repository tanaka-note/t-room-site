(function (global) {
  "use strict";

  const registrations = new Map();
  const pendingRegistrations = new Map();
  const RETRY_DELAYS = [0, 400, 1200, 3000];
  const TRANSFER_CONCURRENCY = 2;
  let workerReady = null;

  async function registerMedia(file, fileKey, endpoint) {
    if (!(fileKey instanceof CryptoKey)) throw new Error("ファイルの暗号化鍵を確認してください。");
    await ensureWorker();
    const token = randomToken();
    const descriptor = descriptorFor(file, endpoint);
    if (descriptor.offlineOnly) {
      if (!descriptor.storageId || !global.TCloudOffline?.supported()) {
        throw new Error("オフライン保存データを確認できません。");
      }
      const saved = await global.TCloudOffline.getEntry(descriptor.storageId);
      if (!saved?.offline || !saved?.complete || String(saved.version) !== descriptor.version) {
        throw new Error("オフライン保存が未完了、または期限切れです。");
      }
    } else if (descriptor.storageId && global.TCloudOffline?.supported()) {
      await global.TCloudOffline.beginEntry({
        id: descriptor.storageId,
        accountScope: descriptor.accountScope,
        rootFolderId: descriptor.rootFolderId,
        fileId: descriptor.fileId,
        version: descriptor.version,
        chunkCount: descriptor.chunkCount,
        chunkSizeBytes: descriptor.chunkSizeBytes,
        sizeBytes: descriptor.sizeBytes,
        encryptedSizeBytes: descriptor.encryptedSizeBytes,
        offline: false,
        complete: false
      }).catch(() => {});
    }
    registrations.set(token, { descriptor, fileKey });
    const cacheLimitBytes = Number(global.TCloudOffline?.getCacheLimitBytes?.() || 0);
    await confirmMediaRegistration({ type: "REGISTER_MEDIA", token, descriptor, fileKey, cacheLimitBytes });
    return { token, url: `/cloud/local-media/${token}` };
  }

  async function confirmMediaRegistration(payload) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const worker = await ensureWorker();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRegistrations.delete(payload.token);
            reject(new Error("専用プレイヤーの準備に時間がかかっています。もう一度お試しください。"));
          }, 2500);
          pendingRegistrations.set(payload.token, {
            resolve: () => { clearTimeout(timer); resolve(); }
          });
          worker.postMessage(payload);
        });
        return;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
  }

  async function ensureWorker() {
    if (!workerReady) workerReady = initializeWorker();
    const registration = await workerReady;
    const worker = navigator.serviceWorker.controller || registration.active;
    if (!worker) throw new Error("専用プレイヤーの準備に時間がかかっています。ページを再読み込みしてください。");
    return worker;
  }

  async function initializeWorker() {
    if (!("serviceWorker" in navigator)) throw new Error("このブラウザは大容量再生に対応していません。");
    const registration = await navigator.serviceWorker.register("/cloud/media-worker.js", { scope: "/cloud/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("専用プレイヤーの準備に時間がかかっています。ページを再読み込みしてください。")), 5000);
        navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    navigator.serviceWorker.addEventListener("message", handleWorkerMessage);
    navigator.serviceWorker.addEventListener("controllerchange", registerMediaWithCurrentWorker);
    return registration;
  }

  function registerMediaWithCurrentWorker() {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return;
    const cacheLimitBytes = Number(global.TCloudOffline?.getCacheLimitBytes?.() || 0);
    worker.postMessage({ type: "SET_CACHE_LIMIT", cacheLimitBytes });
    for (const [token, saved] of registrations) {
      worker.postMessage({
        type: "REGISTER_MEDIA",
        token,
        ...saved,
        cacheLimitBytes
      });
    }
  }

  function handleWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === "MEDIA_REGISTERED") {
      const pending = pendingRegistrations.get(data.token);
      pendingRegistrations.delete(data.token);
      pending?.resolve();
      return;
    }
    if (data.type === "MEDIA_PLAYBACK_FAILURE") {
      console.warn(`[T-Cloud media] ${data.workerBuild || "unknown"} ${data.phase || "playback"}: ${data.message || "unknown error"}`);
      return;
    }
    if (data.type !== "MEDIA_KEY_REQUIRED") return;
    const saved = registrations.get(data.token);
    if (!saved || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: "REGISTER_MEDIA",
      token: data.token,
      ...saved,
      cacheLimitBytes: Number(global.TCloudOffline?.getCacheLimitBytes?.() || 0)
    });
  }

  function releaseMedia(token) {
    registrations.delete(token);
    pendingRegistrations.delete(token);
    navigator.serviceWorker?.controller?.postMessage({ type: "RELEASE_MEDIA", token });
  }

  async function setCacheLimitBytes(value) {
    const cacheLimitBytes = Number(value);
    if (!Number.isFinite(cacheLimitBytes) || cacheLimitBytes <= 0) return;
    const worker = await ensureWorker();
    worker.postMessage({ type: "SET_CACHE_LIMIT", cacheLimitBytes });
  }

  async function chooseDownloadTarget(file) {
    if (!("showSaveFilePicker" in global)) return null;
    return global.showSaveFilePicker({ id: "tcloud-download", suggestedName: safeFilename(file.name), startIn: "downloads" });
  }

  async function chooseDownloadDirectory() {
    if (!("showDirectoryPicker" in global)) return null;
    return global.showDirectoryPicker({ id: "tcloud-downloads", mode: "readwrite", startIn: "downloads" });
  }

  async function streamDownload(file, fileKey, endpoint, targetHandle, options = {}) {
    if (!targetHandle?.createWritable) throw new Error("保存先を確認してください。");
    let writable;
    try {
      writable = await targetHandle.createWritable({ keepExistingData: false, mode: "exclusive" });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      writable = await targetHandle.createWritable({ keepExistingData: false });
    }
    let completed = false;
    try {
      const chunkCount = Number(file.chunkCount || Math.ceil(Number(file.sizeBytes) / Number(file.chunkSizeBytes)));
      let nextIndex = 0;
      const pending = new Map();
      const fillWindow = () => {
        while (nextIndex < chunkCount && pending.size < TRANSFER_CONCURRENCY) {
          const index = nextIndex++;
          pending.set(index, fetchAndDecryptChunk(file, fileKey, endpoint, index, options.signal));
        }
      };
      fillWindow();
      for (let index = 0; index < chunkCount; index++) {
        if (options.signal?.aborted) throw new DOMException("中止しました", "AbortError");
        const plain = await pending.get(index);
        pending.delete(index);
        fillWindow();
        await writable.write(plain);
        plain.fill(0);
        options.onProgress?.(Math.min(Number(file.sizeBytes), (index + 1) * Number(file.chunkSizeBytes)), Number(file.sizeBytes));
      }
      await writable.close();
      completed = true;
    } finally {
      if (!completed) {
        try { await writable.abort(); } catch {}
      }
    }
  }

  async function decryptToBlob(file, fileKey, endpoint, options = {}) {
    const chunkCount = Number(file.chunkCount || Math.ceil(Number(file.sizeBytes) / Number(file.chunkSizeBytes)));
    const chunks = new Array(chunkCount);
    let nextIndex = 0;
    let completedBytes = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= chunkCount) return;
        if (options.signal?.aborted) throw new DOMException("中止しました", "AbortError");
        const plain = await fetchAndDecryptChunk(file, fileKey, endpoint, index, options.signal);
        chunks[index] = plain;
        completedBytes += plain.byteLength;
        options.onProgress?.(Math.min(Number(file.sizeBytes), completedBytes), Number(file.sizeBytes));
      }
    };
    await Promise.all(Array.from({ length: Math.min(TRANSFER_CONCURRENCY, chunkCount) }, worker));
    return new Blob(chunks, { type: file.mimeType || "application/octet-stream" });
  }

  async function fetchAndDecryptChunk(file, fileKey, endpoint, index, signal) {
    const envelope = await fetchEncryptedChunk(file, endpoint, index, signal);
    return new Uint8Array(await TRoomCrypto.decryptFileChunk(fileKey, envelope, index));
  }

  async function fetchEncryptedChunk(file, endpoint, index, signal) {
    const { start, end } = TCloudRange.encryptedChunkRange(file, index);
    if (file.offlineStorageId && global.TCloudOffline?.supported()) {
      const cached = await global.TCloudOffline.getChunk(file.offlineStorageId, index).catch(() => null);
      if (cached) return cached;
    }
    if (file.offlineOnly) throw new Error("端末内のオフラインデータを読み込めませんでした。再保存してください。");
    let lastError;
    for (const delay of RETRY_DELAYS) {
      if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
      if (delay) await wait(delay, signal);
      try {
        const response = await fetch(endpoint, {
          headers: { Range: `bytes=${start}-${end}` },
          credentials: "same-origin",
          cache: "no-store",
          signal
        });
        if (response.status !== 206) throw new Error(`分割データを取得できませんでした（${response.status}）。`);
        const envelope = new Uint8Array(await response.arrayBuffer());
        if (file.offlineStorageId && global.TCloudOffline?.supported()) {
          global.TCloudOffline.putChunk(file.offlineStorageId, index, envelope, { expectedBytes: end - start + 1 }).catch(() => {});
        }
        return envelope;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("分割データを取得できませんでした。");
  }

  async function saveOfflineFile(file, record, endpoint, options = {}) {
    if (!global.TCloudOffline?.supported()) throw new Error("このブラウザはオフライン保存に対応していません。");
    const totalBytes = Number(file.encryptedSizeBytes || file.sizeBytes || 0);
    const estimate = await global.TCloudOffline.storageEstimate();
    const existing = await global.TCloudOffline.getEntry(record.id);
    const existingBytes = Number(existing?.cachedBytes || 0);
    const requiredBytes = Math.max(0, totalBytes - existingBytes);
    if (estimate.quota && requiredBytes > estimate.available) {
      throw new Error(`端末の保存容量が不足しています。あと${formatBytes(requiredBytes - estimate.available)}以上必要です。`);
    }
    await global.TCloudOffline.beginEntry({ ...record, offline: true, complete: false, status: "saving" });
    const entry = await global.TCloudOffline.getEntry(record.id);
    const chunkCount = Number(file.chunkCount || Math.ceil(Number(file.sizeBytes) / Number(file.chunkSizeBytes)));
    let completedBytes = Number(entry?.cachedBytes || 0);
    options.onProgress?.(Math.min(totalBytes, completedBytes), totalBytes);
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        if (options.signal?.aborted) throw new DOMException("中断しました", "AbortError");
        const { start, end } = TCloudRange.encryptedChunkRange(file, index);
        const expectedBytes = end - start + 1;
        const saved = entry?.chunks?.[index];
        if (Number(saved?.bytes || 0) === expectedBytes) continue;
        const envelope = await fetchEncryptedChunk({ ...file, offlineStorageId: "" }, endpoint, index, options.signal);
        await global.TCloudOffline.putChunk(record.id, index, envelope, { expectedBytes, enforceCacheLimit: false });
        completedBytes += envelope.byteLength;
        options.onProgress?.(Math.min(totalBytes, completedBytes), totalBytes);
      }
      return await global.TCloudOffline.markOfflineComplete(record.id);
    } catch (error) {
      await global.TCloudOffline.markInterrupted(record.id, error.name === "AbortError" ? "中断" : error.message);
      throw error;
    }
  }

  function descriptorFor(file, endpoint) {
    return {
      endpoint,
      name: String(file.name || ""),
      sizeBytes: Number(file.sizeBytes),
      chunkSizeBytes: Number(file.chunkSizeBytes || 8 * 1024 * 1024),
      chunkCount: Number(file.chunkCount || Math.ceil(Number(file.sizeBytes) / Number(file.chunkSizeBytes || 8 * 1024 * 1024))),
      mimeType: playbackMimeType(file),
      encryptedSizeBytes: Number(file.encryptedSizeBytes || file.sizeBytes || 0),
      storageId: file.offlineStorageId || "",
      accountScope: file.offlineAccountScope || "",
      rootFolderId: Number(file.offlineRootFolderId || 0),
      fileId: Number(file.id || 0),
      version: String(file.updatedAt || file.createdAt || "1"),
      offlineOnly: Boolean(file.offlineOnly)
    };
  }

  function playbackMimeType(file) {
    const declared = String(file.mimeType || file.type || "").trim().toLowerCase();
    const extension = String(file.name || "").split(".").pop().toLowerCase();
    const byExtension = {
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      flv: "video/x-flv",
      ts: "video/mp2t",
      m2ts: "video/mp2t",
      mts: "video/mp2t",
      mp3: "audio/mpeg",
      m4a: "audio/mp4"
    }[extension];
    return byExtension || declared || "application/octet-stream";
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes || 0));
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[index]}`;
  }

  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function safeFilename(value) {
    const cleaned = String(value || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
    return cleaned.slice(0, 220) || "download";
  }

  function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("中止しました", "AbortError")); }, { once: true });
    });
  }

  global.TCloudMedia = Object.freeze({
    registerMedia,
    releaseMedia,
    setCacheLimitBytes,
    chooseDownloadTarget,
    chooseDownloadDirectory,
    streamDownload,
    decryptToBlob,
    saveOfflineFile,
    safeFilename
  });
})(globalThis);
