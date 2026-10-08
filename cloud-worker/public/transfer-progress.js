/* Transfer accounting owns its progress, retry samples and concurrency queue. */
(() => {
  function connectionLimitForFile(limit, totalFiles) {
    return totalFiles > 1 ? Math.max(1, Math.ceil(limit / 2)) : limit;
  }

  function createUploadLimiter(limit) {
    let active = 0;
    const queue = [];
    const runNext = () => {
      if (active >= limit || !queue.length) return;
      active++;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active--;
        runNext();
      });
    };
    const limiter = (task) => new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
    limiter.limit = limit;
    return limiter;
  }

  function createTracker(files, totalBytes, { formatBytes, render, completed, now: clock = () => performance.now(), setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
    const startedAt = clock();
    const active = new Map();
    const partsByFile = new Map(files.map((file) => [file, new Map()]));
    const networkAttemptsByFile = new Map(files.map((file) => [file, new Map()]));
    const completedFiles = new Set();
    const samples = [];
    let networkBytes = 0;
    let lastActivityAt = 0;
    let phaseStartedAt = startedAt;
    let currentPhase = "送信準備中";
    let stopped = false;
    const uploadedFor = (file) => {
      if (completedFiles.has(file)) return Number(file.size || 0);
      return [...(partsByFile.get(file)?.values() || [])].reduce((sum, part) => sum + Math.min(Number(part.size || 0), Number(part.loaded || 0)), 0);
    };
    const refresh = () => {
      if (stopped) return;
      const now = clock();
      const uploadedBytes = files.reduce((sum, file) => sum + uploadedFor(file), 0);
      const percent = totalBytes ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 100;
      while (samples.length > 2 && samples[0].time < now - 8000) samples.shift();
      const firstSample = samples[0];
      const lastSample = samples.at(-1);
      const sampleSeconds = firstSample && lastSample ? Math.max(.25, (lastSample.time - firstSample.time) / 1000) : 0;
      const bytesPerSecond = sampleSeconds > 0 ? Math.max(0, (lastSample.bytes - firstSample.bytes) / sampleSeconds) : 0;
      const remainingSeconds = bytesPerSecond > 0 ? Math.max(0, totalBytes - uploadedBytes) / bytesPerSecond : 0;
      const secondsSinceActivity = lastActivityAt ? Math.max(0, Math.floor((now - lastActivityAt) / 1000)) : 0;
      const communicating = currentPhase === "Cloudflareへ送信中";
      const waiting = communicating && lastActivityAt && secondsSinceActivity >= 15;
      const phaseElapsed = Math.max(0, Math.floor((now - phaseStartedAt) / 1000));
      const activity = waiting
        ? `通信応答待ち・最終通信${secondsSinceActivity}秒前`
        : communicating
        ? (lastActivityAt ? `通信中・最終通信${secondsSinceActivity}秒前` : "通信開始待ち")
        : phaseElapsed >= 2 ? `${currentPhase}（${phaseElapsed}秒経過）` : currentPhase;
      const names = [...active.keys()].map((file) => file.name);
      render({
        width: `${percent}%`,
        percent: `${percent.toFixed(percent >= 10 ? 1 : 2)}%`,
        speed: bytesPerSecond > 0 ? formatTransferRate(bytesPerSecond, formatBytes) : "速度計測中",
        bytes: `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`,
        eta: bytesPerSecond > 0 && uploadedBytes < totalBytes ? `残り約${formatTransferDuration(remainingSeconds)}` : (uploadedBytes >= totalBytes ? "送信完了" : "残り時間：計算中"),
        activity,
        waiting: Boolean(waiting || currentPhase.startsWith("通信再試行中")),
        fileName: names.length > 1 ? `${names[0]} ほか${names.length - 1}件` : (names[0] || "")
      });
    };
    const timer = setInterval(refresh, 1000);
    return {
      start(file) { active.set(file, true); refresh(); },
      partProgress(file, partNumber, attempt, loaded, size, completed = false) {
        const parts = partsByFile.get(file);
        if (!parts) return;
        const attemptKey = `${partNumber}:${attempt}`;
        const attempts = networkAttemptsByFile.get(file);
        if (!(completed && attempt === 0)) {
          const previousNetworkLoaded = Number(attempts.get(attemptKey) || 0);
          const currentNetworkLoaded = Math.max(previousNetworkLoaded, Number(loaded || 0));
          attempts.set(attemptKey, currentNetworkLoaded);
          networkBytes += Math.max(0, currentNetworkLoaded - previousNetworkLoaded);
        }
        if (completed) parts.set(partNumber, { attempt, loaded: size, size, completed: true });
        else if (!parts.get(partNumber)?.completed) parts.set(partNumber, { attempt, loaded, size, completed: false });
        lastActivityAt = clock();
        currentPhase = "Cloudflareへ送信中";
        phaseStartedAt = lastActivityAt;
        samples.push({ time: lastActivityAt, bytes: networkBytes });
        refresh();
      },
      retry(file, partNumber, nextAttempt, maxAttempts) {
        const parts = partsByFile.get(file);
        const current = parts?.get(partNumber);
        if (parts && !current?.completed) parts.set(partNumber, { attempt: nextAttempt, loaded: 0, size: Number(current?.size || 0), completed: false });
        currentPhase = `通信再試行中 ${nextAttempt}/${maxAttempts}回`;
        phaseStartedAt = clock();
        refresh();
      },
      phase(file, label) {
        if (!active.has(file)) return;
        currentPhase = label.replace(/…$/, "");
        phaseStartedAt = clock();
        refresh();
      },
      finish(file, count) {
        completedFiles.add(file);
        active.delete(file);
        completed(count, files.length);
        refresh();
      },
      defer(file) {
        partsByFile.set(file, new Map());
        completedFiles.delete(file);
        active.delete(file);
        refresh();
      },
      stop() {
        stopped = true;
        clearInterval(timer);
      }
    };
  }

  function formatTransferRate(bytesPerSecond, formatBytes) {
    const mbps = (Number(bytesPerSecond || 0) * 8) / 1_000_000;
    return `${mbps.toFixed(mbps >= 10 ? 1 : 2)} Mbps（${formatBytes(bytesPerSecond)}/秒）`;
  }

  function formatTransferDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds || 0)));
    if (value < 60) return `${Math.max(1, value)}秒`;
    if (value < 3600) return `${Math.ceil(value / 60)}分`;
    const hours = Math.floor(value / 3600);
    const minutes = Math.ceil((value % 3600) / 60);
    return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
  }

  globalThis.TCloudTransfer = Object.freeze({ createLimiter: createUploadLimiter, connectionLimitForFile, createTracker, formatRate: formatTransferRate, formatDuration: formatTransferDuration });
})();
