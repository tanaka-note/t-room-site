// Photo presentation owns image loading and gestures; session, history and uploads stay with the caller.
export function createPhotoViewer({ nodes, selection, formatDate, formatBytes, createImage = () => new Image() }) {
  let imageRequestId = 0;
  let imageLoad = null;

  function bindPhotoViewerSwipe() {
    const stage = nodes.stage;
    let gesture = null;
    // A second finger anywhere in the viewer belongs to pinch/zoom, not navigation.
    nodes.dialog.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" && !event.isPrimary) gesture = null;
    }, { capture: true });
    stage.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || !event.isPrimary || !nodes.dialog.open) return;
      if ((window.visualViewport?.scale || 1) > 1) return;
      // Leave edge gestures to the OS/browser Back navigation.
      if (event.clientX < 24 || event.clientX > window.innerWidth - 24) return;
      gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener("pointermove", (event) => {
      if (gesture?.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) gesture = null;
    });
    stage.addEventListener("pointerup", (event) => {
      if (gesture?.pointerId !== event.pointerId) return;
      const start = gesture;
      gesture = null;
      if (!nodes.dialog.open || (window.visualViewport?.scale || 1) > 1) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const threshold = Math.max(40, Math.min(80, stage.clientWidth * 0.12));
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      movePhotoViewer(dx < 0 ? 1 : -1);
    });
    const cancel = (event) => {
      if (gesture?.pointerId === event.pointerId) gesture = null;
    };
    stage.addEventListener("pointercancel", cancel);
    stage.addEventListener("lostpointercapture", cancel);
    nodes.dialog.addEventListener("close", () => { gesture = null; });
    nodes.dialog.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      movePhotoViewer(event.key === "ArrowLeft" ? -1 : 1);
    });
  }

  function cancelPhotoViewerImageLoad() {
    imageRequestId++;
    if (imageLoad) {
      imageLoad.onload = null;
      imageLoad.onerror = null;
      imageLoad.removeAttribute("src");
      imageLoad = null;
    }
  }

  function loadPhotoViewerImage(photo) {
    cancelPhotoViewerImageLoad();
    const requestId = imageRequestId;
    // A new element cannot paint the previous photo while this source loads.
    const preview = createImage();
    preview.id = "photo-viewer-image";
    preview.draggable = false;
    preview.alt = photo.fileName || "日記の写真";
    preview.hidden = !photo.thumbnailUrl;
    if (photo.thumbnailUrl) preview.src = photo.thumbnailUrl;
    nodes.image.replaceWith(preview);
    nodes.image = preview;
    nodes.status.textContent = "写真を読み込んでいます...";
    nodes.status.hidden = false;

    const image = createImage();
    image.id = preview.id;
    image.draggable = false;
    image.alt = preview.alt;
    image.decoding = "async";
    imageLoad = image;
    const isCurrent = () => requestId === imageRequestId;
    preview.onerror = () => { if (isCurrent()) preview.hidden = true; };
    const failed = () => {
      if (!isCurrent()) return;
      imageLoad = null;
      nodes.status.textContent = "写真を読み込めませんでした。";
    };
    image.onerror = failed;
    image.onload = async () => {
      try {
        await image.decode();
        if (!isCurrent()) return;
        image.onload = null;
        image.onerror = null;
        imageLoad = null;
        nodes.image.replaceWith(image);
        nodes.image = image;
        nodes.status.hidden = true;
      } catch {
        failed();
      }
    };
    image.src = photo.displayUrl;
  }

  function renderPhotoViewer() {
    const photo = selection.photos[selection.index];
    if (!photo) return;
    nodes.date.textContent = formatDate(photo.entryDate);
    nodes.title.textContent = photo.entryTitle || "日記の写真";
    loadPhotoViewerImage(photo);
    const dimensions = photo.width && photo.height ? ` / ${photo.width}×${photo.height}` : "";
    nodes.file.textContent = `${photo.fileName} / ${formatBytes(photo.originalSize)}${dimensions}`;
    nodes.downloadLow.href = `${photo.displayUrl}?download=1`;
    nodes.downloadOriginal.href = `${photo.originalUrl}?download=1`;
  }

  function movePhotoViewer(direction) {
    const next = selection.index + direction;
    if (next < 0 || next >= selection.photos.length) return;
    selection.index = next;
    renderPhotoViewer();
  }

  return Object.freeze({ bind: bindPhotoViewerSwipe, render: renderPhotoViewer, cancelLoad: cancelPhotoViewerImageLoad });
}
