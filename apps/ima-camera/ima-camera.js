(() => {
  const standaloneQuery = window.matchMedia?.("(display-mode: standalone)");
  const isStandalone = Boolean(standaloneQuery?.matches || window.navigator.standalone);
  document.documentElement.classList.toggle("is-standalone", isStandalone);

  const video = document.querySelector("#cameraVideo");
  const preview = document.querySelector("#photoPreview");
  const canvas = document.querySelector("#captureCanvas");
  const cameraFrame = document.querySelector("#cameraFrame");
  const emptyState = document.querySelector("#emptyState");
  const flashOverlay = document.querySelector("#flashOverlay");
  const statusText = document.querySelector("#statusText");
  const shutterButton = document.querySelector("#shutterButton");
  const switchButton = document.querySelector("#switchButton");
  const saveButton = document.querySelector("#saveButton");
  const shareButton = document.querySelector("#shareButton");
  const retakeButton = document.querySelector("#retakeButton");
  const timeToggle = document.querySelector("#timeToggle");
  const optionSummary = document.querySelector("#optionSummary");
  const markButtons = Array.from(document.querySelectorAll(".mark-button"));

  if (!video || !preview || !canvas || !cameraFrame || !emptyState || !flashOverlay || !statusText || !shutterButton || !switchButton || !saveButton || !shareButton || !retakeButton || !timeToggle || !optionSummary || markButtons.length === 0) {
    return;
  }

  const SETTINGS_KEY = "t-room-ima-camera-settings";
  const moods = {
    none: { label: "なし", slug: "none" },
    sunny: { label: "Happy", slug: "happy" },
    fair: { label: "Good", slug: "good" },
    cloudy: { label: "Think", slug: "think" },
    rainy: { label: "Blue", slug: "blue" },
    quiet: { label: "Calm", slug: "calm" },
    growing: { label: "Grow", slug: "grow" },
  };

  let stream = null;
  let facingMode = "environment";
  let selectedMark = "none";
  let photoBlob = null;
  let photoUrl = "";
  let photoFileName = "";
  let photoDate = null;
  let audioContext = null;
  let busy = false;

  function loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      timeToggle.checked = Boolean(settings.includeTime);
    } catch (error) {
      timeToggle.checked = false;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ includeTime: timeToggle.checked }));
    } catch (error) {
      // Settings are optional.
    }
  }

  function setStatus(message) {
    statusText.textContent = message;
  }

  function setBusy(value) {
    busy = value;
    shutterButton.disabled = value || !stream || cameraFrame.classList.contains("has-photo");
    switchButton.disabled = value || !stream || cameraFrame.classList.contains("has-photo");
  }

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("このブラウザではカメラを起動できません。");
      emptyState.querySelector("p").textContent = "カメラを起動できません";
      return;
    }

    setBusy(true);
    stopStream();
    cameraFrame.classList.remove("is-ready", "has-photo");
    preview.hidden = true;
    video.hidden = false;
    emptyState.querySelector("p").textContent = "カメラを起動しています";

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1440 },
          height: { ideal: 1440 },
        },
      });
      video.srcObject = stream;
      await video.play();
      cameraFrame.classList.add("is-ready");
      setStatus("撮影できます。");
    } catch (error) {
      stream = null;
      setStatus("カメラの許可が必要です。ブラウザの設定を確認してください。");
      emptyState.querySelector("p").textContent = "カメラの許可が必要です";
    } finally {
      setBusy(false);
    }
  }

  function getAudioContext() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!audioContext) audioContext = new AudioCtor();
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {});
    }
    return audioContext;
  }

  function tone(context, start, frequency, duration, type, gain) {
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function noise(context, start, duration, gain, filterFrequency) {
    const length = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);

    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / length);
    }

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const volume = context.createGain();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(filterFrequency, start);
    filter.Q.setValueAtTime(1.8, start);
    volume.gain.setValueAtTime(0.0001, start);
    volume.gain.exponentialRampToValueAtTime(gain, start + 0.006);
    volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(volume);
    volume.connect(context.destination);
    source.start(start);
  }

  function playShutterSound() {
    const context = getAudioContext();
    if (!context) return;

    const now = context.currentTime;
    tone(context, now, 620, 0.055, "triangle", 0.052);
    noise(context, now + 0.018, 0.045, 0.04, 1150);
    tone(context, now + 0.06, 420, 0.07, "sine", 0.028);
  }

  function flash() {
    flashOverlay.classList.remove("is-active");
    void flashOverlay.offsetWidth;
    flashOverlay.classList.add("is-active");
  }

  function formatStampDate(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month}.${day} ${hour}:${minute}`;
  }

  function formatFileDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}-${hour}${minute}`;
  }

  function drawCloud(ctx, x, y, size) {
    ctx.beginPath();
    ctx.arc(x + size * 0.3, y + size * 0.55, size * 0.19, Math.PI * 0.92, Math.PI * 1.92);
    ctx.arc(x + size * 0.48, y + size * 0.43, size * 0.24, Math.PI, Math.PI * 1.95);
    ctx.arc(x + size * 0.68, y + size * 0.56, size * 0.19, Math.PI * 1.18, Math.PI * 0.1);
    ctx.lineTo(x + size * 0.26, y + size * 0.74);
    ctx.quadraticCurveTo(x + size * 0.16, y + size * 0.68, x + size * 0.3, y + size * 0.55);
    ctx.closePath();
    ctx.fill();
  }

  function drawMark(ctx, mark, centerX, centerY, size) {
    if (mark === "none") return;

    ctx.save();
    ctx.translate(centerX - size / 2, centerY - size / 2);
    ctx.fillStyle = "rgba(246, 246, 246, 0.76)";
    ctx.strokeStyle = "rgba(246, 246, 246, 0.76)";
    ctx.lineWidth = Math.max(3, size * 0.08);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (mark === "sunny") {
      const cx = size * 0.5;
      const cy = size * 0.5;
      const radius = size * 0.18;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI * 2 * index) / 8;
        const inner = size * 0.32;
        const outer = size * 0.42;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(size * 0.42, size * 0.46, size * 0.025, 0, Math.PI * 2);
      ctx.arc(size * 0.58, size * 0.46, size * 0.025, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(size * 0.5, size * 0.51, size * 0.085, 0.18 * Math.PI, 0.82 * Math.PI);
      ctx.stroke();
    }

    if (mark === "fair") {
      ctx.beginPath();
      ctx.arc(size * 0.64, size * 0.32, size * 0.04, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(size * 0.18, size * 0.58);
      ctx.quadraticCurveTo(size * 0.5, size * 0.38, size * 0.82, size * 0.58);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(size * 0.26, size * 0.72);
      ctx.lineTo(size * 0.74, size * 0.72);
      ctx.stroke();
    }

    if (mark === "cloudy") {
      [
        [0.38, 0.38, 0.16],
        [0.55, 0.42, 0.18],
        [0.45, 0.58, 0.14],
      ].forEach(([x, y, radius]) => {
        ctx.beginPath();
        ctx.arc(size * x, size * y, size * radius, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.beginPath();
      ctx.arc(size * 0.24, size * 0.74, size * 0.035, 0, Math.PI * 2);
      ctx.arc(size * 0.36, size * 0.8, size * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }

    if (mark === "rainy") {
      ctx.beginPath();
      ctx.moveTo(size * 0.5, size * 0.14);
      ctx.bezierCurveTo(size * 0.68, size * 0.34, size * 0.76, size * 0.5, size * 0.76, size * 0.65);
      ctx.bezierCurveTo(size * 0.76, size * 0.8, size * 0.64, size * 0.9, size * 0.5, size * 0.9);
      ctx.bezierCurveTo(size * 0.36, size * 0.9, size * 0.24, size * 0.8, size * 0.24, size * 0.65);
      ctx.bezierCurveTo(size * 0.24, size * 0.5, size * 0.32, size * 0.34, size * 0.5, size * 0.14);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(size * 0.5, size * 0.6, size * 0.1, 0.14 * Math.PI, 0.86 * Math.PI);
      ctx.stroke();
    }

    if (mark === "quiet") {
      ctx.beginPath();
      ctx.arc(size * 0.52, size * 0.34, size * 0.22, Math.PI * 0.2, Math.PI * 1.64);
      ctx.quadraticCurveTo(size * 0.34, size * 0.34, size * 0.52, size * 0.12);
      ctx.arc(size * 0.44, size * 0.34, size * 0.2, Math.PI * 1.58, Math.PI * 0.26, true);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(size * 0.18, size * 0.68);
      ctx.quadraticCurveTo(size * 0.32, size * 0.58, size * 0.46, size * 0.68);
      ctx.quadraticCurveTo(size * 0.6, size * 0.78, size * 0.78, size * 0.66);
      ctx.stroke();
    }

    if (mark === "growing") {
      ctx.beginPath();
      ctx.moveTo(size * 0.5, size * 0.88);
      ctx.lineTo(size * 0.5, size * 0.44);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(size * 0.36, size * 0.38, size * 0.16, size * 0.28, -0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(size * 0.64, size * 0.38, size * 0.16, size * 0.28, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawStamp(ctx, size, date) {
    const hasMark = selectedMark !== "none";
    const hasDate = timeToggle.checked;
    if (!hasMark && !hasDate) return;

    const pad = Math.round(size * 0.04);
    const iconSize = Math.round(size * 0.075);
    const fontSize = Math.round(size * 0.026);
    const gap = Math.round(size * 0.012);
    const right = size - pad;
    let bottom = size - pad;

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
    ctx.shadowBlur = Math.round(size * 0.01);
    ctx.shadowOffsetY = Math.round(size * 0.003);

    if (hasDate) {
      ctx.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(246, 246, 246, 0.68)";
      ctx.fillText(formatStampDate(date), right, bottom);
      bottom -= fontSize + gap;
    }

    if (hasMark) {
      const centerX = right - iconSize / 2;
      const centerY = bottom - iconSize / 2;
      drawMark(ctx, selectedMark, centerX, centerY, iconSize);
    }

    ctx.restore();
  }

  function buildFileName(date) {
    const mood = moods[selectedMark] || moods.none;
    const suffix = selectedMark === "none" ? "" : `-${mood.slug}`;
    return `ima-${formatFileDate(date)}${suffix}.jpg`;
  }

  function updateMarkButtons() {
    markButtons.forEach((button) => {
      const active = button.dataset.mark === selectedMark;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-pressed", String(active));
    });
    updateOptionSummary();
  }

  function updateOptionSummary() {
    const mood = moods[selectedMark] || moods.none;
    const markText = selectedMark === "none" ? "印なし" : mood.label;
    const timeText = timeToggle.checked ? "日時あり" : "日時なし";
    optionSummary.textContent = `${markText} / ${timeText}`;
  }

  function revokePhotoUrl() {
    if (!photoUrl) return;
    URL.revokeObjectURL(photoUrl);
    photoUrl = "";
  }

  function showPhoto(blob, fileName, date) {
    revokePhotoUrl();
    photoBlob = blob;
    photoFileName = fileName;
    photoDate = date;
    photoUrl = URL.createObjectURL(blob);
    preview.src = photoUrl;
    preview.hidden = false;
    cameraFrame.classList.add("has-photo");
    saveButton.hidden = false;
    shareButton.hidden = false;
    retakeButton.hidden = false;
    shutterButton.hidden = true;
    switchButton.hidden = true;
    setStatus("撮影しました。保存または共有できます。");
  }

  async function capturePhoto() {
    if (!stream || busy || video.readyState < 2) return;

    setBusy(true);
    playShutterSound();
    flash();

    const date = new Date();
    const outputSize = 1080;
    const context = canvas.getContext("2d");
    const sourceSize = Math.min(video.videoWidth, video.videoHeight);
    const sourceX = (video.videoWidth - sourceSize) / 2;
    const sourceY = (video.videoHeight - sourceSize) / 2;

    canvas.width = outputSize;
    canvas.height = outputSize;
    context.drawImage(video, sourceX, sourceY, sourceSize, sourceSize, 0, 0, outputSize, outputSize);
    drawStamp(context, outputSize, date);

    canvas.toBlob((blob) => {
      if (!blob) {
        setStatus("画像を作成できませんでした。");
        setBusy(false);
        return;
      }

      showPhoto(blob, buildFileName(date), date);
      setBusy(false);
    }, "image/jpeg", 0.92);
  }

  function retake() {
    revokePhotoUrl();
    photoBlob = null;
    photoFileName = "";
    photoDate = null;
    preview.hidden = true;
    preview.removeAttribute("src");
    cameraFrame.classList.remove("has-photo");
    saveButton.hidden = true;
    shareButton.hidden = true;
    retakeButton.hidden = true;
    shutterButton.hidden = false;
    switchButton.hidden = false;
    setStatus(stream ? "撮影できます。" : "カメラの許可を確認しています。");
    setBusy(false);
  }

  function savePhoto() {
    if (!photoBlob) return;

    const link = document.createElement("a");
    link.href = URL.createObjectURL(photoBlob);
    link.download = photoFileName || "ima.jpg";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 800);
    setStatus("保存を開始しました。");
  }

  async function sharePhoto() {
    if (!photoBlob) return;

    const file = new File([photoBlob], photoFileName || "ima.jpg", { type: photoBlob.type || "image/jpeg" });
    if (!navigator.canShare?.({ files: [file] }) || !navigator.share) {
      setStatus("この環境では共有できません。保存を使ってください。");
      return;
    }

    try {
      await navigator.share({
        files: [file],
        title: "今を撮る",
      });
      setStatus("共有を開きました。");
    } catch (error) {
      setStatus("共有をキャンセルしました。");
    }
  }

  async function switchCamera() {
    if (busy) return;
    facingMode = facingMode === "environment" ? "user" : "environment";
    await startCamera();
  }

  markButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedMark = button.dataset.mark || "none";
      updateMarkButtons();
      if (photoBlob && photoDate) {
        retake();
      }
    });
  });

  timeToggle.addEventListener("change", () => {
    saveSettings();
    updateOptionSummary();
    if (photoBlob && photoDate) {
      retake();
    }
  });

  shutterButton.addEventListener("click", capturePhoto);
  switchButton.addEventListener("click", switchCamera);
  saveButton.addEventListener("click", savePhoto);
  shareButton.addEventListener("click", sharePhoto);
  retakeButton.addEventListener("click", retake);

  window.addEventListener("pagehide", stopStream);

  loadSettings();
  updateMarkButtons();
  startCamera();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
        // The camera still works when offline caching is unavailable.
      });
    });
  }
})();
