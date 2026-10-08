/* Video controls own scrubbing and rendering; playback and fullscreen stay with the caller. */
(() => {
  function previewControlIcon(name) {
    const paths = {
      play: '<path d="M8 5v14l11-7z"/>',
      pause: '<path d="M6.5 5h4v14h-4zm7 0h4v14h-4z"/>',
      volume: '<path d="M4 9v6h4l5 4V5L8 9zm11.5-.8v7.6a5 5 0 0 0 0-7.6zm0-3.2v2.1a7 7 0 0 1 0 9.8V19a9 9 0 0 0 0-14z"/>',
      muted: '<path d="M4 9v6h4l5 4V5L8 9zm12.2 1.6 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1 1.4-1.4z"/>',
      fullscreen: '<path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/>',
      "fullscreen-exit": '<path d="M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
  }

  function formatPreviewPlaybackTime(value) {
    const total = Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function relativeSeekTime(startSeconds, pointerStartX, pointerCurrentX, trackWidth, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const width = Math.max(1, Number(trackWidth) || 1);
    const deltaSeconds = (Number(pointerCurrentX) - Number(pointerStartX)) / width * duration;
    return Math.max(0, Math.min(duration, Number(startSeconds || 0) + deltaSeconds));
  }

  function absoluteSeekTime(pointerX, trackLeft, trackWidth, duration) {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const width = Math.max(1, Number(trackWidth) || 1);
    const ratio = (Number(pointerX) - Number(trackLeft)) / width;
    return Math.max(0, Math.min(duration, ratio * duration));
  }

  function attach(stage, video, file, { getPlayer, bindPreviewPlaybackMode, togglePreviewPlayerFullscreen, syncPreviewSeekbarFullscreenControl }) {
    stage.classList.add("has-custom-video-controls");
    const controls = document.createElement("div");
    controls.className = "preview-player-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "動画の再生操作");
    controls.innerHTML = `
      <button class="preview-player-button preview-player-play" type="button" aria-label="再生">${previewControlIcon("play")}</button>
      <span class="preview-player-time">0:00 / 0:00</span>
      <div class="preview-player-seek" role="slider" tabindex="-1" aria-label="再生位置" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="0" aria-disabled="true"></div>
      <button class="preview-player-button preview-playback-mode preview-player-mode" type="button" aria-label="リピート：オフ" aria-pressed="false"><svg class="ui-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2 6"/></svg></button>
      <button class="preview-player-button preview-player-mute" type="button" aria-label="消音">${previewControlIcon("volume")}</button>
      <button class="preview-player-button preview-player-fullscreen" type="button" aria-label="全画面で表示" aria-pressed="false">${previewControlIcon("fullscreen")}</button>`;
    const playButton = controls.querySelector(".preview-player-play");
    const timeLabel = controls.querySelector(".preview-player-time");
    const seek = controls.querySelector(".preview-player-seek");
    const modeButton = controls.querySelector(".preview-player-mode");
    const muteButton = controls.querySelector(".preview-player-mute");
    const fullscreenButton = controls.querySelector(".preview-player-fullscreen");
    let playbackFrame = 0;
    let lastPaused = null;
    let lastTimeText = "";
    let lastSeekValue = "";
    let lastBufferedPercent = "";
    let cachedPlaybackPercent = file?.offlineOnly ? 100 : 0;
    let seekPreviewActive = false;
    let pendingSeekSeconds = 0;
    let seekPointerId = null;
    let seekPointerStartX = 0;
    let seekPointerStartSeconds = 0;
    let seekPointerUsesAbsolutePosition = false;
    const bufferedEnd = (duration) => {
      if (!duration || !video.buffered?.length) return 0;
      let end = 0;
      for (let index = 0; index < video.buffered.length; index += 1) end = Math.max(end, video.buffered.end(index));
      return Math.min(duration, end);
    };
    const syncPlayback = () => {
      playbackFrame = 0;
      if (!controls.isConnected && stage.isConnected) return;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const current = seekPreviewActive
        ? pendingSeekSeconds
        : (Number.isFinite(video.currentTime) ? video.currentTime : 0);
      if (lastPaused !== video.paused) {
        lastPaused = video.paused;
        playButton.innerHTML = previewControlIcon(video.paused ? "play" : "pause");
        playButton.setAttribute("aria-label", video.paused ? "再生" : "一時停止");
      }
      const timeText = `${formatPreviewPlaybackTime(current)} / ${formatPreviewPlaybackTime(duration)}`;
      if (lastTimeText !== timeText) {
        lastTimeText = timeText;
        timeLabel.textContent = timeText;
        seek.setAttribute("aria-valuetext", timeText);
      }
      seek.setAttribute("aria-disabled", String(!duration));
      seek.tabIndex = duration ? 0 : -1;
      const seekValue = duration ? String(Math.min(1000, Math.round(current / duration * 1000))) : "0";
      if (!seekPreviewActive && lastSeekValue !== seekValue) {
        lastSeekValue = seekValue;
        seek.setAttribute("aria-valuenow", seekValue);
      }
      const playedPercent = duration ? Math.min(100, current / duration * 100) : 0;
      const bufferedPercent = duration ? Math.max(playedPercent, bufferedEnd(duration) / duration * 100, cachedPlaybackPercent) : 0;
      const bufferedValue = bufferedPercent.toFixed(2);
      seek.style.setProperty("--played-percent", `${playedPercent.toFixed(2)}%`);
      if (lastBufferedPercent !== bufferedValue) {
        lastBufferedPercent = bufferedValue;
        seek.style.setProperty("--buffered-percent", `${bufferedValue}%`);
      }
    };
    const queuePlaybackSync = () => {
      if (!playbackFrame) playbackFrame = requestAnimationFrame(syncPlayback);
    };
    const refreshCachedPlayback = async () => {
      if (!controls.isConnected) return;
      if (file?.offlineOnly) {
        cachedPlaybackPercent = 100;
      } else if (file?.offlineStorageId && globalThis.TCloudOffline?.supported()) {
        const entry = await TCloudOffline.getEntry(file.offlineStorageId).catch(() => null);
        cachedPlaybackPercent = contiguousCachedPlaybackPercent(file, entry);
      }
      queuePlaybackSync();
      if (controls.isConnected) setTimeout(refreshCachedPlayback, 800);
    };
    const syncVolume = () => {
      muteButton.innerHTML = previewControlIcon(video.muted || video.volume === 0 ? "muted" : "volume");
      muteButton.setAttribute("aria-label", video.muted || video.volume === 0 ? "音声を出す" : "消音");
    };
    playButton.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    const previewSeek = (targetSeconds) => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      seekPreviewActive = true;
      pendingSeekSeconds = Math.max(0, Math.min(video.duration, Number(targetSeconds) || 0));
      lastSeekValue = String(Math.min(1000, Math.round(pendingSeekSeconds / video.duration * 1000)));
      seek.setAttribute("aria-valuenow", lastSeekValue);
      syncPlayback();
    };
    const commitSeek = () => {
      if (!seekPreviewActive || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const target = Math.max(0, Math.min(video.duration, pendingSeekSeconds));
      seekPreviewActive = false;
      try {
        const player = getPlayer();
        if (player) player.currentTime = target;
        else video.currentTime = target;
      } catch {
        video.currentTime = target;
      }
      queuePlaybackSync();
    };
    seek.addEventListener("pointerdown", (event) => {
      if (seek.getAttribute("aria-disabled") === "true") return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      seekPointerId = event.pointerId;
      seekPointerStartX = event.clientX;
      seekPointerStartSeconds = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      seekPointerUsesAbsolutePosition = event.pointerType === "mouse";
      const bounds = seek.getBoundingClientRect();
      previewSeek(seekPointerUsesAbsolutePosition
        ? absoluteSeekTime(event.clientX, bounds.left, bounds.width, video.duration)
        : seekPointerStartSeconds);
      seek.classList.add("is-scrubbing");
      seek.focus({ preventScroll: true });
      try { seek.setPointerCapture(event.pointerId); } catch {}
    });
    seek.addEventListener("pointermove", (event) => {
      if (seekPointerId === null || event.pointerId !== seekPointerId) return;
      event.preventDefault();
      const bounds = seek.getBoundingClientRect();
      previewSeek(seekPointerUsesAbsolutePosition
        ? absoluteSeekTime(event.clientX, bounds.left, bounds.width, video.duration)
        : relativeSeekTime(seekPointerStartSeconds, seekPointerStartX, event.clientX, bounds.width, video.duration));
    });
    const finishRelativeSeek = (event) => {
      if (seekPointerId === null || event.pointerId !== seekPointerId) return;
      event.preventDefault();
      if (event.type === "pointerup") {
        const bounds = seek.getBoundingClientRect();
        previewSeek(seekPointerUsesAbsolutePosition
          ? absoluteSeekTime(event.clientX, bounds.left, bounds.width, video.duration)
          : relativeSeekTime(seekPointerStartSeconds, seekPointerStartX, event.clientX, bounds.width, video.duration));
      }
      try { seek.releasePointerCapture(seekPointerId); } catch {}
      seekPointerId = null;
      seekPointerUsesAbsolutePosition = false;
      seek.classList.remove("is-scrubbing");
      commitSeek();
    };
    seek.addEventListener("pointerup", finishRelativeSeek);
    seek.addEventListener("pointercancel", finishRelativeSeek);
    seek.addEventListener("keydown", (event) => {
      if (seek.getAttribute("aria-disabled") === "true") return;
      const step = event.shiftKey ? 30 : 5;
      let target = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") target -= step;
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") target += step;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = video.duration;
      else return;
      event.preventDefault();
      previewSeek(target);
      commitSeek();
    });
    muteButton.addEventListener("click", () => { video.muted = !video.muted; });
    bindPreviewPlaybackMode(modeButton, video, file);
    fullscreenButton.addEventListener("click", togglePreviewPlayerFullscreen);
    for (const eventName of ["click", "dblclick", "pointerdown", "pointerup", "touchstart", "touchend"]) {
      controls.addEventListener(eventName, (event) => event.stopPropagation());
    }
    for (const eventName of ["loadedmetadata", "durationchange", "timeupdate", "progress", "canplay", "seeked", "tcloud:seek-feedback"]) video.addEventListener(eventName, queuePlaybackSync);
    for (const eventName of ["play", "pause", "ended"]) video.addEventListener(eventName, syncPlayback);
    video.addEventListener("volumechange", syncVolume);
    stage.append(controls);
    syncPlayback();
    syncVolume();
    syncPreviewSeekbarFullscreenControl();
    setTimeout(refreshCachedPlayback, 250);
  }

  function contiguousCachedPlaybackPercent(file, entry) {
    if (!entry) return 0;
    if (file?.offlineOnly && entry.complete) return 100;
    const sizeBytes = Number(file?.sizeBytes || entry.sizeBytes || 0);
    const chunkSizeBytes = Number(file?.chunkSizeBytes || entry.chunkSizeBytes || 8 * 1024 * 1024);
    const chunkCount = Number(file?.chunkCount || entry.chunkCount || Math.ceil(sizeBytes / chunkSizeBytes));
    if (!sizeBytes || !chunkCount || !entry.chunks) return 0;
    let contiguousChunks = 0;
    while (contiguousChunks < chunkCount && entry.chunks[contiguousChunks]) contiguousChunks += 1;
    const cachedPlainBytes = Math.min(sizeBytes, contiguousChunks * chunkSizeBytes);
    return Math.min(100, cachedPlainBytes / sizeBytes * 100);
  }

  globalThis.TCloudPreviewControls = Object.freeze({ attach, previewControlIcon, formatPreviewPlaybackTime, relativeSeekTime, absoluteSeekTime, contiguousCachedPlaybackPercent });
})();
