// Synthetic localhost fixtures only; never load this observer in production.
export async function installMediaDiagnostics(page, eventsOnly = false) {
  await page.addInitScript(eventsOnly => {
    const ranges = value => Array.from({ length: value.length }, (_, i) => [value.start(i), value.end(i)]);
    globalThis.__mediaDiagnostics = { events: [], plays: [], checkpoints: [] };
    globalThis.__mediaSnapshot = video => ({
      currentTime: video.currentTime, duration: video.duration, paused: video.paused,
      ended: video.ended, seeking: video.seeking, readyState: video.readyState,
      networkState: video.networkState, error: video.error && { code: video.error.code, message: video.error.message },
      buffered: ranges(video.buffered), seekable: ranges(video.seekable), played: ranges(video.played),
      src: video.src, currentSrc: video.currentSrc, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      muted: video.muted, volume: video.volume, playbackRate: video.playbackRate
    });
    for (const name of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing',
      'pause', 'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'timeupdate', 'progress', 'durationchange', 'error', 'emptied', 'abort']) {
      document.addEventListener(name, event => {
        if (!(event.target instanceof HTMLVideoElement)) return;
        __mediaDiagnostics.events.push({ event: name, at: performance.now(), ...(eventsOnly ? {} : { state: __mediaSnapshot(event.target) }) });
        if (__mediaDiagnostics.events.length > 2000) __mediaDiagnostics.events.shift();
      }, true);
    }
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      const record = { at: performance.now(), status: 'pending', before: __mediaSnapshot(this) };
      __mediaDiagnostics.plays.push(record);
      let promise;
      try { promise = original.apply(this, args); }
      catch (error) { record.status = 'threw'; record.error = String(error); throw error; }
      promise?.then(() => { record.status = 'resolved'; record.after = __mediaSnapshot(this); }, error => {
        record.status = 'rejected'; record.error = `${error.name}: ${error.message}`; record.after = __mediaSnapshot(this);
      });
      return promise;
    };
  }, eventsOnly);
}

export async function mediaCheckpoint(page, phase) {
  await page.evaluate(phase => __mediaDiagnostics.checkpoints.push({ phase, at: performance.now(), state: __mediaSnapshot(__video) }), phase);
}

export async function reportMediaDiagnostics(page, label) {
  console.error('MEDIA DIAGNOSTICS', label, JSON.stringify(await page.evaluate(() => ({
    final: __video && __mediaSnapshot(__video), ...__mediaDiagnostics
  }))));
}
