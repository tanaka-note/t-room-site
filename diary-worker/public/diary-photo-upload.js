const PHOTO_UPLOAD_RETRY_DELAYS_MS = Object.freeze([1000, 3000, 7000]);
const PHOTO_UPLOAD_CONCURRENCY = 3;
const PHOTO_UPLOAD_PARALLEL_BYTES = 16 * 1024 * 1024;
const PHOTO_UPLOAD_TIMEOUT_MS = 180000;
const PHOTO_STATUS_TIMEOUT_MS = 10000;

export function createPhotoUploadManager({ state, api, basePath, getTargetEntryId }) {
  const activeBytes = new Map();
  let degraded = false;
  let retryNotBefore = 0;

  function canStartPhoto(photo) {
    if (!activeBytes.size) return true;
    const connection = globalThis.navigator?.connection;
    if (degraded || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || "")) return false;
    const bytes = [...activeBytes.values()].reduce((sum, size) => sum + size, 0);
    return activeBytes.size < PHOTO_UPLOAD_CONCURRENCY && bytes + photoBytes(photo) <= PHOTO_UPLOAD_PARALLEL_BYTES;
  }

  function photoBytes(photo) {
    return (photo.originalFile?.size || 0) + (photo.displayBlob?.size || 0) + (photo.thumbnailBlob?.size || 0);
  }
  function createPhotoUploadForm(photo) {
    const form = new FormData();
    form.set("id", photo.id);
    form.set("width", String(photo.width || ""));
    form.set("height", String(photo.height || ""));
    form.set("original", photo.originalFile, photo.fileName);
    form.set("display", photo.displayBlob, "display.webp");
    form.set("thumbnail", photo.thumbnailBlob, "thumbnail.webp");
    return form;
  }

  function releaseUploadedPhotoPayload(photo, { releasePreview = false } = {}) {
    photo.originalFile = null;
    photo.displayBlob = null;
    photo.thumbnailBlob = null;
    if (releasePreview && photo.previewUrl) {
      URL.revokeObjectURL(photo.previewUrl);
      photo.previewUrl = null;
    }
  }

  function waitForPhotoUploadRetry(attemptIndex) {
    const delay = Math.max(PHOTO_UPLOAD_RETRY_DELAYS_MS[attemptIndex] * (0.75 + Math.random() * 0.5), retryNotBefore - Date.now());
    return new Promise((resolve) => window.setTimeout(resolve, delay));
  }

  function logPhotoUploadRetry(requestId, attempt, details) {
    console.warn("Diary photo upload", {
      stage: "photo-upload",
      requestId,
      attempt,
      ...details
    });
  }

  async function ensurePhotoUploadSession() {
    if (state.photoUploadSessionId) return state.photoUploadSessionId;
    if (state.photoUploadSessionPromise) return state.photoUploadSessionPromise;
    degraded = false;
    retryNotBefore = 0;
    const targetEntryId = getTargetEntryId();
    state.photoUploadTargetEntryId = targetEntryId;
    state.photoUploadSessionPromise = api("/photo-upload-sessions", {
      method: "POST",
      body: { targetEntryId },
      preserveEditor: true,
      onTiming: (timing) => { state.photoUploadSessionTiming = timing; }
    }).then((result) => {
      state.photoUploadSessionId = result.uploadSession.id;
      return state.photoUploadSessionId;
    }).finally(() => {
      state.photoUploadSessionPromise = null;
    });
    return state.photoUploadSessionPromise;
  }

  function queueBackgroundPhotoUpload(photo) {
    if (photo.existing || photo.removed || photo.uploadState === "uploaded") return Promise.resolve(photo);
    if (photo.uploadPromise) return photo.uploadPromise;
    const queuedAt = Date.now();
    const metrics = photo.uploadMetrics = { bytes: photoBytes(photo), queueMs: 0, attempts: [] };
    photo.uploadState = "uploading";
    photo.uploadError = null;
    state.photoUploadPendingCount += 1;
    state.photoUploading = true;
    const queued = (async () => {
      while (!canStartPhoto(photo)) {
        await Promise.race(state.photoUploadActiveTasks);
      }
      if (photo.removed) return null;
      metrics.queueMs = Date.now() - queuedAt;
      activeBytes.set(photo.id, photoBytes(photo));
      const activeTask = uploadPhotoToStaging(photo);
      const settledTask = activeTask.catch(() => null);
      state.photoUploadActiveTasks.add(settledTask);
      try {
        const result = await activeTask;
        photo.uploadState = "uploaded";
        photo.uploadError = null;
        if (photo.removed) await deleteStagedPhotoUpload(photo, { waitForUpload: false });
        releaseUploadedPhotoPayload(photo);
        return result;
      } catch (error) {
        photo.uploadState = "failed";
        photo.uploadError = error;
        return null;
      } finally {
        activeBytes.delete(photo.id);
        state.photoUploadActiveTasks.delete(settledTask);
      }
    })();
    photo.uploadPromise = queued.finally(() => {
      metrics.elapsedMs = Date.now() - queuedAt;
      metrics.outcome = photo.uploadState;
      photo.uploadPromise = null;
      state.photoUploadPendingCount = Math.max(0, state.photoUploadPendingCount - 1);
      state.photoUploading = state.photoUploadPendingCount > 0;
    });
    return photo.uploadPromise;
  }

  async function uploadPhotoToStaging(photo) {
    const uploadSessionId = await ensurePhotoUploadSession();
    const url = `${basePath}/api/photo-upload-sessions/${uploadSessionId}/photos`;
    const maxAttempts = PHOTO_UPLOAD_RETRY_DELAYS_MS.length + 1;
    let lastError = null;
    if (photo.uploadOutcomeUnknown) {
      const recovered = await confirmPhotoUpload(url, photo);
      if (recovered) return recovered;
    }
    if (retryNotBefore - Date.now() > 30000) {
      throw new Error("写真の送信が混み合っています。少し待って再試行してください。編集内容は保持しています。");
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingWait = retryNotBefore - Date.now();
      if (remainingWait > 0) await new Promise(resolve => window.setTimeout(resolve, remainingWait));
      const requestId = crypto.randomUUID();
      const started = Date.now();
      const controller = new AbortController();
      // Leave slower links time proportional to payload size, with a hard bound.
      const timeoutMs = Math.min(15 * 60 * 1000, PHOTO_UPLOAD_TIMEOUT_MS + photoBytes(photo) / (64 * 1024) * 1000);
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      let response, result;
      let errorType = "network";
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "X-Diary-Request": "1", "X-Diary-Upload-Request": requestId },
          credentials: "same-origin",
          signal: controller.signal,
          body: createPhotoUploadForm(photo)
        });
        errorType = "invalid-response";
        result = await response.json();
      } catch (cause) {
        result = {};
        if (controller.signal.aborted) errorType = "timeout";
        else if (cause?.name === "NotReadableError") errorType = "file-read";
      } finally {
        window.clearTimeout(timer);
        photo.uploadMetrics.attempts.push({
          elapsedMs: Date.now() - started,
          status: response?.status || 0,
          serverTiming: response?.headers.get("Server-Timing") || ""
        });
      }

      if (response?.ok && result?.photo?.id === photo.id) {
        photo.uploadOutcomeUnknown = false;
        return result;
      }
      const status = response?.status || 0;
      const retryable = !response || response.ok || status === 408 || status === 429 || status >= 500;
      degraded = degraded || retryable;
      const retryAfter = response?.headers.get("Retry-After");
      const waitMs = retryAfter && (/^\d+(\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
      if (Number.isFinite(waitMs) && waitMs > 0 && (status === 429 || status === 503)) {
        retryNotBefore = Math.max(retryNotBefore, Date.now() + waitMs);
      }
      lastError = new Error(status === 401 ? "ログインの有効期限が切れました。編集内容を保持しています。再ログイン後に再試行してください。"
        : status === 403 ? "写真を保存する権限を確認してください。編集内容は保持しています。"
        : result.error || (status === 429 ? "写真の送信が混み合っています。少し待って再試行してください。"
          : "写真の送信結果を確認できませんでした。編集内容は保持しています。通信が安定してから再試行してください。"));
      lastError.status = status;
      logPhotoUploadRetry(requestId, attempt + 1, {
        status, errorType: response && !response.ok ? "http" : errorType,
        elapsedMs: Date.now() - started, ray: response?.headers.get("cf-ray")?.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64)
      });
      photo.uploadOutcomeUnknown = !response || response.ok || status >= 500 || status === 408;
      if (photo.uploadOutcomeUnknown) {
        const recovered = await confirmPhotoUpload(url, photo);
        if (recovered) return recovered;
      }
      if (!retryable || attempt === maxAttempts - 1 || retryNotBefore - Date.now() > 30000) {
        throw lastError;
      }
      await waitForPhotoUploadRetry(attempt);
    }
    throw lastError || new Error("画像を保存できませんでした。");
  }

  async function confirmPhotoUpload(url, photo) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PHOTO_STATUS_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/${photo.id}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if ([401, 403, 409].includes(response.status)) {
        const error = new Error(response.status === 409 ? "画像の一時保存期限が切れました。写真を追加し直してください。"
          : "写真の保存確認に必要なログイン・権限を確認してください。編集内容は保持しています。");
        error.status = response.status;
        throw error;
      }
      if (!response.ok) return null;
      const result = await response.json();
      if (result?.photo?.id !== photo.id) return null;
      photo.uploadOutcomeUnknown = false;
      return result;
    } catch (error) {
      if (error.status) throw error;
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function ensurePhotosUploaded(photos) {
    const alreadyFailed = new Set(photos.filter(photo => !photo.uploadPromise && photo.uploadState !== "uploaded"));
    await Promise.all(photos.map((photo) => photo.uploadPromise || Promise.resolve()));
    const failed = photos.filter((photo) => alreadyFailed.has(photo) && photo.uploadState !== "uploaded");
    if (failed.length) {
      await Promise.all(failed.map((photo) => queueBackgroundPhotoUpload(photo)));
    }
    const remaining = photos.filter((photo) => photo.uploadState !== "uploaded");
    if (remaining.length) {
      throw new Error(remaining.map((photo) => `${photo.fileName}：${photo.uploadError?.message || "画像を保存できませんでした。"}`).join(" / "));
    }
  }

  async function deleteStagedPhotoUpload(photo, { waitForUpload = true } = {}) {
    photo.removed = true;
    if (waitForUpload && photo.uploadPromise) await photo.uploadPromise;
    if (photo.uploadState !== "uploaded" || !state.photoUploadSessionId) return;
    state.photoUploadPendingCount += 1;
    state.photoUploading = true;
    try {
      const response = await fetch(`${basePath}/api/photo-upload-sessions/${state.photoUploadSessionId}/photos/${photo.id}`, {
        method: "DELETE",
        headers: { "X-Diary-Request": "1" },
        credentials: "same-origin",
        keepalive: true
      });
      if (!response.ok) throw new Error("一時保存した画像を削除できませんでした。");
      photo.uploadState = "removed";
    } finally {
      state.photoUploadPendingCount = Math.max(0, state.photoUploadPendingCount - 1);
      state.photoUploading = state.photoUploadPendingCount > 0;
    }
  }

  async function commitStagedPhotos(entryId, photos) {
    if (!state.photoUploadSessionId) return [];
    const result = await api(`/photo-upload-sessions/${state.photoUploadSessionId}/commit`, {
      method: "POST",
      body: { entryId, photoIds: photos.map((photo) => photo.id) },
      preserveEditor: true
    });
    state.photoUploadCommitted = true;
    return result.photos || [];
  }

  async function cancelEditorPhotoUploadSession() {
    if (!state.photoUploadSessionId && state.photoUploadSessionPromise) {
      await state.photoUploadSessionPromise.catch(() => null);
    }
    const uploadSessionId = state.photoUploadSessionId;
    if (!uploadSessionId || state.photoUploadCommitted) return;
    await Promise.allSettled([
      ...state.photoUploadActiveTasks,
      ...state.editorPhotos.map((photo) => photo.uploadPromise).filter(Boolean)
    ]);
    try {
      await fetch(`${basePath}/api/photo-upload-sessions/${uploadSessionId}`, {
        method: "DELETE",
        headers: { "X-Diary-Request": "1" },
        credentials: "same-origin",
        keepalive: true
      });
    } catch {
      // The server-side expiry cleanup removes abandoned staging data.
    }
  }

  return {
    cancelEditorPhotoUploadSession,
    commitStagedPhotos,
    deleteStagedPhotoUpload,
    ensurePhotosUploaded,
    queueBackgroundPhotoUpload,
    releaseUploadedPhotoPayload
  };
}
