const PHOTO_UPLOAD_RETRY_DELAYS_MS = Object.freeze([250, 750]);
const PHOTO_UPLOAD_CONCURRENCY = 2;

export function createPhotoUploadManager({ state, api, basePath, getTargetEntryId }) {
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
    return new Promise((resolve) => window.setTimeout(resolve, PHOTO_UPLOAD_RETRY_DELAYS_MS[attemptIndex]));
  }

  function logPhotoUploadRetry(uploadTarget, photoId, attempt, details) {
    console.warn("Diary photo upload retry", {
      stage: "photo-upload",
      uploadTarget,
      photoId,
      retry: attempt,
      ...details
    });
  }

  async function ensurePhotoUploadSession() {
    if (state.photoUploadSessionId) return state.photoUploadSessionId;
    if (state.photoUploadSessionPromise) return state.photoUploadSessionPromise;
    const targetEntryId = getTargetEntryId();
    state.photoUploadTargetEntryId = targetEntryId;
    state.photoUploadSessionPromise = api("/photo-upload-sessions", {
      method: "POST",
      body: { targetEntryId }
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
    photo.uploadState = "uploading";
    photo.uploadError = null;
    state.photoUploadPendingCount += 1;
    state.photoUploading = true;
    const queued = (async () => {
      while (state.photoUploadActiveTasks.size >= PHOTO_UPLOAD_CONCURRENCY) {
        await Promise.race(state.photoUploadActiveTasks);
      }
      if (photo.removed) return null;
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
        state.photoUploadActiveTasks.delete(settledTask);
      }
    })();
    photo.uploadPromise = queued.finally(() => {
      photo.uploadPromise = null;
      state.photoUploadPendingCount = Math.max(0, state.photoUploadPendingCount - 1);
      state.photoUploading = state.photoUploadPendingCount > 0;
    });
    return photo.uploadPromise;
  }

  async function uploadPhotoToStaging(photo) {
    const uploadSessionId = await ensurePhotoUploadSession();
    const maxAttempts = PHOTO_UPLOAD_RETRY_DELAYS_MS.length + 1;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response;
      try {
        response = await fetch(`${basePath}/api/photo-upload-sessions/${uploadSessionId}/photos`, {
          method: "POST",
          headers: { "X-Diary-Request": "1" },
          credentials: "same-origin",
          body: createPhotoUploadForm(photo)
        });
      } catch {
        lastError = new Error("画像の通信に失敗しました。");
        if (attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
        logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "network" });
        await waitForPhotoUploadRetry(attempt);
        continue;
      }

      let result;
      try {
        result = await response.json();
      } catch {
        result = {};
        if (response.ok) {
          lastError = new Error("画像の保存結果を確認できませんでした。");
          if (attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
          logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "invalid-response", status: response.status });
          await waitForPhotoUploadRetry(attempt);
          continue;
        }
      }

      if (response.ok && result?.photo?.id === photo.id) return result;
      if (response.ok) {
        lastError = new Error("画像の保存結果を確認できませんでした。");
        if (attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) throw lastError;
        logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "invalid-response", status: response.status });
        await waitForPhotoUploadRetry(attempt);
        continue;
      }

      lastError = new Error(result.error || "画像を保存できませんでした。");
      if (response.status < 500 || response.status > 599 || attempt >= PHOTO_UPLOAD_RETRY_DELAYS_MS.length) {
        throw lastError;
      }
      logPhotoUploadRetry(uploadSessionId, photo.id, attempt + 1, { errorType: "http", status: response.status });
      await waitForPhotoUploadRetry(attempt);
    }
    throw lastError || new Error("画像を保存できませんでした。");
  }

  async function ensurePhotosUploaded(photos) {
    await Promise.all(photos.map((photo) => photo.uploadPromise || Promise.resolve()));
    const failed = photos.filter((photo) => photo.uploadState !== "uploaded");
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
      body: { entryId, photoIds: photos.map((photo) => photo.id) }
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
