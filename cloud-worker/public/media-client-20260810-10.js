(function (global) {
  "use strict";

  const registrations = new Map();
  const pendingRegistrations = new Map();
  const RETRY_DELAYS = [0, 400, 1200, 3000];
  const TRANSFER_CONCURRENCY = 2;
  let workerReady = null;

  async function registerMedia(file, fileKey, endpoint) {
    if (!(fileKey instanceof CryptoKey)) throw new Error("ファイルの暗号化鍵を確認してください。");
    const worker = await ensureWorker();
    const token = randomToken();
    const descriptor = descriptorFor(file, endpoint);
    registrations.set(token, { descriptor, fileKey });
    await confirmMediaRegistration(worker, { type: "REGISTER_MEDIA", token, descriptor, fileKey });
    return { token, url: `/cloud/local-media/${token}` };
  }

  async function confirmMediaRegistration(worker, payload) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
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
    return workerReady;
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
    return navigator.serviceWorker.controller || registration.active;
  }

  function handleWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === "MEDIA_REGISTERED") {
      const pending = pendingRegistrations.get(data.token);
      pendingRegistrations.delete(data.token);
      pending?.resolve();
      return;
    }
    if (data.type !== "MEDIA_KEY_REQUIRED") return;
    const saved = registrations.get(data.token);
    if (!saved || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({ type: "REGISTER_MEDIA", token: data.token, ...saved });
  }

  function releaseMedia(token) {
    registrations.delete(token);
    pendingRegistrations.delete(token);
    navigator.serviceWorker?.controller?.postMessage({ type: "RELEASE_MEDIA", token });
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
    const { start, end } = TCloudRange.encryptedChunkRange(file, index);
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
        return new Uint8Array(await TRoomCrypto.decryptFileChunk(fileKey, await response.arrayBuffer(), index));
      } catch (error) {
        if (error.name === "AbortError") throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("分割データを取得できませんでした。");
  }

  function descriptorFor(file, endpoint) {
    return {
      endpoint,
      sizeBytes: Number(file.sizeBytes),
      chunkSizeBytes: Number(file.chunkSizeBytes || 8 * 1024 * 1024),
      chunkCount: Number(file.chunkCount || Math.ceil(Number(file.sizeBytes) / Number(file.chunkSizeBytes || 8 * 1024 * 1024))),
      mimeType: file.mimeType || "application/octet-stream"
    };
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
    chooseDownloadTarget,
    chooseDownloadDirectory,
    streamDownload,
    decryptToBlob,
    safeFilename
  });
})(globalThis);
