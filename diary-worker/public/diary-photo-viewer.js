// Photo presentation owns image loading and gestures; session, history and uploads stay with the caller.
export function createPhotoViewer({ nodes, selection, formatDate, formatBytes, createImage = () => new Image() }) {
  let imageRequestId = 0;
  let imageLoad = null;
  let scale = 1, offsetX = 0, offsetY = 0;
  const pointers = new Map();
  let gesture = null;

  function paintTransform() {
    if (!nodes.stage) return;
    const photo = selection.photos[selection.index];
    const width = nodes.stage.clientWidth, height = nodes.stage.clientHeight;
    const imageWidth = nodes.image.naturalWidth || photo?.width || width;
    const imageHeight = nodes.image.naturalHeight || photo?.height || height;
    const fit = imageWidth > 0 && imageHeight > 0 ? Math.min(width / imageWidth, height / imageHeight) : 0;
    const limitX = Math.max(0, (imageWidth * fit * scale - width) / 2);
    const limitY = Math.max(0, (imageHeight * fit * scale - height) / 2);
    offsetX = Math.max(-limitX, Math.min(limitX, offsetX));
    offsetY = Math.max(-limitY, Math.min(limitY, offsetY));
    nodes.stage.style.setProperty('--photo-scale', scale);
    nodes.stage.style.setProperty('--photo-x', `${offsetX}px`);
    nodes.stage.style.setProperty('--photo-y', `${offsetY}px`);
    nodes.stage.classList.toggle('is-zoomed', scale > 1);
    if (nodes.zoomReset) {
      nodes.zoomReset.textContent = `${Math.round(scale * 100)}%`;
      nodes.zoomReset.setAttribute('aria-label', `拡大率 ${Math.round(scale * 100)}%。元の大きさに戻す`);
    }
  }

  function zoomAt(nextScale, clientX, clientY) {
    const rect = nodes.stage.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    const next = Math.max(1, Math.min(6, nextScale));
    const ratio = next / scale;
    offsetX = x - (x - offsetX) * ratio;
    offsetY = y - (y - offsetY) * ratio;
    scale = next;
    paintTransform();
  }

  function resetTransform() {
    pointers.clear();
    gesture = null;
    scale = 1;
    offsetX = offsetY = 0;
    paintTransform();
  }

  function syncFullscreen() {
    const active = document.fullscreenElement === nodes.shell;
    nodes.fullscreen?.setAttribute('aria-pressed', String(active));
    if (nodes.fullscreen) {
      nodes.fullscreen.textContent = active ? '全画面を解除' : '全画面';
      nodes.fullscreen.setAttribute('aria-label', active ? '全画面を解除' : '全画面で表示');
    }
    paintTransform();
  }

  function exitFullscreen() {
    if (document.fullscreenElement === nodes.shell) document.exitFullscreen().catch(() => {});
  }

  function bindPhotoViewerSwipe() {
    const stage = nodes.stage;
    // A second finger outside the stage must also cancel photo navigation.
    nodes.dialog.addEventListener("pointerdown", (event) => {
      if (event.pointerType === 'touch' && !event.isPrimary && !stage.contains(event.target)) gesture = null;
    }, { capture: true });
    stage.addEventListener("pointerdown", (event) => {
      if (!nodes.dialog.open || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if ((window.visualViewport?.scale || 1) > 1) return;
      // Leave edge gestures to the OS/browser Back navigation.
      if (event.pointerType === 'touch' && (event.clientX < 24 || event.clientX > window.innerWidth - 24)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { kind: 'pinch', distance: Math.hypot(a.x - b.x, a.y - b.y),
          x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      } else if (pointers.size === 1) {
        gesture = { kind: scale > 1 ? 'pan' : 'swipe', pointerId: event.pointerId,
          pointerType: event.pointerType, x: event.clientX, y: event.clientY,
          offsetX, offsetY };
      } else gesture = null;
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!gesture) return;
      if (gesture.kind === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
        if (gesture.distance > 0) zoomAt(scale * distance / gesture.distance, gesture.x, gesture.y);
        offsetX += x - gesture.x;
        offsetY += y - gesture.y;
        paintTransform();
        gesture = { kind: 'pinch', distance, x, y };
        return;
      }
      if (gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (gesture.kind === 'pan') {
        offsetX = gesture.offsetX + dx;
        offsetY = gesture.offsetY + dy;
        paintTransform();
      } else if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) gesture = null;
    });
    stage.addEventListener("pointerup", (event) => {
      pointers.delete(event.pointerId);
      const start = gesture;
      // Never reinterpret the remaining finger after a pinch as a swipe.
      gesture = null;
      if (start?.kind !== 'swipe' || start.pointerId !== event.pointerId || start.pointerType !== 'touch') return;
      if (!nodes.dialog.open || (window.visualViewport?.scale || 1) > 1) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const threshold = Math.max(40, Math.min(80, stage.clientWidth * 0.12));
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      movePhotoViewer(dx < 0 ? 1 : -1);
    });
    const cancel = (event) => {
      if (pointers.delete(event.pointerId)) gesture = null;
    };
    stage.addEventListener("pointercancel", cancel);
    stage.addEventListener("lostpointercapture", cancel);
    stage.addEventListener('wheel', event => {
      if (!nodes.dialog.open || !event.deltaY) return;
      event.preventDefault();
      gesture = null;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const delta = Math.max(-600, Math.min(600, event.deltaY * unit));
      zoomAt(scale * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', event => {
      event.preventDefault();
      zoomAt(scale > 1 ? 1 : 2, event.clientX, event.clientY);
    });
    nodes.zoomReset?.addEventListener('click', resetTransform);
    if (nodes.fullscreen) {
      nodes.fullscreen.hidden = !document.fullscreenEnabled || !nodes.shell.requestFullscreen;
      nodes.fullscreen.addEventListener('click', async () => {
        try {
          if (document.fullscreenElement === nodes.shell) await document.exitFullscreen();
          else await nodes.shell.requestFullscreen();
          // A close/session reset can happen while the browser grants fullscreen.
          if (!nodes.dialog.open) exitFullscreen();
        } catch {
          if (!nodes.dialog.open) return;
          nodes.status.textContent = 'この環境では全画面に切り替えられません。';
          nodes.status.hidden = false;
        }
      });
      document.addEventListener('fullscreenchange', syncFullscreen);
    }
    new ResizeObserver(paintTransform).observe(stage);
    nodes.dialog.addEventListener('close', () => { resetTransform(); exitFullscreen(); });
    // Some browsers deliver Escape to the modal even while its child is fullscreen.
    // Consume that request before the shared dialog handler can pop its history.
    const leaveFullscreenFirst = event => {
      if (document.fullscreenElement !== nodes.shell) return;
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      exitFullscreen();
    };
    nodes.dialog.addEventListener('keydown', leaveFullscreenFirst, { capture: true });
    nodes.dialog.addEventListener('cancel', leaveFullscreenFirst, { capture: true });
    nodes.dialog.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== '+')) return;
      if (event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      if (['+', '=', '-', '0'].includes(event.key)) {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        zoomAt(event.key === '0' ? 1 : scale * (event.key === '-' ? 1 / 1.25 : 1.25),
          rect.left + rect.width / 2, rect.top + rect.height / 2);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      if (scale === 1 && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      if (scale > 1) {
        offsetX += event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0;
        offsetY += event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0;
        paintTransform();
      } else movePhotoViewer(event.key === "ArrowLeft" ? -1 : 1);
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
        paintTransform();
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
    resetTransform();
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
