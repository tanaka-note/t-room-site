(function (global) {
  'use strict';

  // The video element and existing controls remain the player. Only static TS
  // with supported codecs uses the local remux worker; other codecs retain the
  // existing mpegts path. MP4/WebM/MOV never enter this adapter.
  function createPlayer(source, config) {
    let video, mediaSource, objectUrl, worker, legacy, destroyed = false;
    let generation = 0, pending = false, ended = false, duration = 0, bufferedEnd = 0;
    let started = false, timer, seekTimer;
    const buffers = new Map(), handlers = new Map(), allocations = [];
    const emit = (event, ...args) => handlers.get(event)?.(...args);
    const fail = () => emit(mpegts.Events.ERROR);
    const stopWorker = () => { generation++; worker?.terminate(); worker = null; pending = false; };
    const valid = () => !destroyed && video && mediaSource?.readyState === 'open';

    async function update(buffer, action) {
      if (!valid()) throw new Error('Player closed');
      if (buffer.updating) await new Promise((resolve, reject) => {
        buffer.addEventListener('updateend', resolve, { once: true });
        buffer.addEventListener('error', reject, { once: true });
      });
      if (!valid()) throw new Error('Player closed');
      return new Promise((resolve, reject) => {
        const done = () => { buffer.removeEventListener('error', error); resolve(); };
        const error = () => { buffer.removeEventListener('updateend', done); reject(new Error('SourceBuffer failure')); };
        buffer.addEventListener('updateend', done, { once: true });
        buffer.addEventListener('error', error, { once: true });
        try { action(); } catch (failure) { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', error); reject(failure); }
      });
    }

    function fallback() {
      stopWorker();
      if (started || destroyed) { if (!destroyed) fail(); return; }
      legacy = mpegts.createPlayer(source, config);
      legacy.on(mpegts.Events.ERROR, fail);
      legacy.attachMediaElement(video);
      legacy.load();
    }

    async function start(time) {
      if (destroyed || legacy) return;
      stopWorker();
      pending = true;
      ended = false;
      bufferedEnd = time;
      const current = generation;
      worker = new Worker('/cloud/media-remux-worker.mjs', { type: 'module' });
      worker.onerror = fallback;
      worker.onmessage = async ({ data }) => {
        if (current !== generation || destroyed) return;
        try {
          if (data.type === 'error') { fallback(); return; }
          if (data.type === 'ready') {
            if (!valid() || data.tracks.some(track => !MediaSource.isTypeSupported(track.mime))) { fallback(); return; }
            duration = data.duration;
            if (!started) {
              for (const track of data.tracks) {
                buffers.set(track.type, mediaSource.addSourceBuffer(track.mime));
              }
              for (const track of data.tracks) {
                const buffer = buffers.get(track.type);
                await update(buffer, () => buffer.appendBuffer(track.init));
                if (current !== generation) return;
              }
              mediaSource.duration = duration;
              started = true;
            }
            for (const buffer of buffers.values()) {
              if (buffer.buffered.length) await update(buffer, () => buffer.remove(0, duration));
              if (current !== generation) return;
            }
            allocations.length = 0;
            pending = true;
            worker.postMessage({ type: 'pull' });
          } else if (data.type === 'data') {
            for (const fragment of data.fragments) {
              if (current !== generation) return;
              // Evict old plaintext media before accepting more, independently
              // of file size. Never accumulate the entire video or a Blob.
              const cutoff = Math.max(0, video.currentTime - 30);
              const buffer = buffers.get(fragment.type);
              if (cutoff > 0 && buffer.buffered.length && buffer.buffered.start(0) < cutoff) await update(buffer, () => buffer.remove(0, cutoff));
              if (current !== generation) return;
              while (allocations.length && allocations[0].end < cutoff) allocations.shift();
              if (allocations.reduce((sum, item) => sum + item.size, 0) + fragment.bytes.length > 64 * 1024 * 1024) throw new Error('Remux buffer limit');
              await update(buffer, () => buffer.appendBuffer(fragment.bytes));
              fragment.bytes.fill(0);
              allocations.push({ end: data.end, size: fragment.bytes.length });
            }
            if (current !== generation) return;
            bufferedEnd = Math.max(bufferedEnd, data.end);
            ended = data.eof;
            pending = false;
            // Keep MediaSource open for later seeks, including backward from EOF.
            pump();
          }
        } catch { if (current === generation && !destroyed) fallback(); }
      };
      worker.postMessage({ type: 'open', url: source.url, size: source.filesize, time });
    }

    function pump() {
      if (worker && !pending && !ended && bufferedEnd < video.currentTime + 15) {
        pending = true;
        worker.postMessage({ type: 'pull' });
      }
    }

    function seek() {
      if (!started || legacy || destroyed) return;
      const time = video.currentTime;
      const covered = [...buffers.values()].every(buffer => {
        for (let i = 0; i < buffer.buffered.length; i++) if (time >= buffer.buffered.start(i) && time + .15 < buffer.buffered.end(i)) return true;
        return false;
      });
      if (covered) { pump(); return; }
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => void start(Math.min(time, duration - .1)), 30);
    }

    return {
      on(event, callback) { handlers.set(event, callback); },
      attachMediaElement(element) { video = element; },
      load() {
        const local = new URL(source.url, location.href);
        if (local.origin !== location.origin || !local.pathname.startsWith('/cloud/local-media/')) { fail(); return; }
        mediaSource = new MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        video.src = objectUrl;
        video.addEventListener('seeking', seek);
        video.addEventListener('timeupdate', pump);
        timer = setInterval(pump, 250);
        mediaSource.addEventListener('sourceopen', () => void start(0), { once: true });
      },
      unload() { stopWorker(); legacy?.unload(); },
      detachMediaElement() { legacy?.detachMediaElement(); },
      destroy() {
        destroyed = true;
        stopWorker();
        clearInterval(timer); clearTimeout(seekTimer);
        video?.removeEventListener('seeking', seek);
        video?.removeEventListener('timeupdate', pump);
        legacy?.destroy();
        URL.revokeObjectURL(objectUrl);
        buffers.clear(); allocations.length = 0; handlers.clear();
      }
    };
  }
  global.TCloudRemux = Object.freeze({ createPlayer });
})(globalThis);
