(function (global) {
  'use strict';

  // The video element and existing controls remain the player. Static TS/FLV
  // with supported codecs uses the local remux worker; other codecs retain the
  // existing mpegts path. MP4/WebM/MOV never enter this adapter.
  function createPlayer(source, config) {
    let video, mediaSource, objectUrl, worker, legacy, destroyed = false;
    let generation = 0, pending = false, ended = false, duration = 0, bufferedEnd = 0;
    let started = false, timer, seekTimer, openingTime = null;
    const buffers = new Map(), handlers = new Map(), allocations = [];
    const emit = (event, ...args) => handlers.get(event)?.(...args);
    const fail = () => emit(mpegts.Events.ERROR);
    const stopWorker = () => { generation++; worker?.terminate(); worker = null; pending = false; openingTime = null; };
    const valid = () => !destroyed && video && mediaSource?.readyState === 'open';

    async function update(buffer, action, current) {
      if (!valid() || current !== generation) throw new Error('Player closed or superseded');
      if (buffer.updating) await new Promise((resolve, reject) => {
        const done = () => { buffer.removeEventListener('error', error); resolve(); };
        const error = () => { buffer.removeEventListener('updateend', done); reject(new Error('SourceBuffer failure')); };
        buffer.addEventListener('updateend', done, { once: true });
        buffer.addEventListener('error', error, { once: true });
      });
      if (!valid() || current !== generation) throw new Error('Player closed or superseded');
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
      openingTime = time;
      ended = false;
      bufferedEnd = time;
      const current = generation;
      worker = new Worker('/cloud/media-remux-worker.mjs', { type: 'module' });
      worker.onerror = () => { if (current === generation && !destroyed) fallback(); };
      worker.onmessage = async ({ data }) => {
        if (current !== generation || destroyed) { data.fragments?.forEach(fragment => fragment.bytes.fill(0)); return; }
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
                await update(buffer, () => buffer.appendBuffer(track.init), current);
                if (current !== generation) return;
              }
              mediaSource.duration = duration;
              started = true;
            }
            for (const buffer of buffers.values()) {
              if (buffer.buffered.length) await update(buffer, () => buffer.remove(0, duration), current);
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
              if (cutoff > 0 && buffer.buffered.length && buffer.buffered.start(0) < cutoff) await update(buffer, () => buffer.remove(0, cutoff), current);
              if (current !== generation) return;
              while (allocations.length && allocations[0].end < cutoff) allocations.shift();
              if (allocations.reduce((sum, item) => sum + item.size, 0) + fragment.bytes.length > 64 * 1024 * 1024) throw new Error('Remux buffer limit');
              try { await update(buffer, () => buffer.appendBuffer(fragment.bytes), current); }
              finally { fragment.bytes.fill(0); }
              if (current !== generation) return;
              allocations.push({ end: data.end, size: fragment.bytes.length });
            }
            if (current !== generation) return;
            bufferedEnd = Math.max(bufferedEnd, data.end);
            ended = data.eof;
            pending = false;
            openingTime = null;
            // Keep MediaSource open for later seeks, including backward from EOF.
            pump();
          }
        } catch { if (current === generation && !destroyed) fallback(); }
        finally { data.fragments?.forEach(fragment => fragment.bytes.fill(0)); }
      };
      worker.postMessage({ type: 'open', url: source.url, size: source.filesize, time, container: source.type === 'flv' ? 'flv' : 'mpeg-ts' });
    }

    function pump() {
      if (worker && !pending && !ended && bufferedEnd < video.currentTime + 15) {
        pending = true;
        worker.postMessage({ type: 'pull' });
      }
    }

    function covered(time) {
      return [...buffers.values()].every(buffer => {
        for (let i = 0; i < buffer.buffered.length; i++) if (time >= buffer.buffered.start(i) && time + .15 < buffer.buffered.end(i)) return true;
        return false;
      });
    }

    function seek() {
      if (!started || legacy || destroyed) return;
      clearTimeout(seekTimer);
      seekTimer = null;
      const time = video.currentTime;
      const staleOpening = openingTime !== null && Math.abs(openingTime - time) > .3;
      if (worker && openingTime !== null && !staleOpening) return;
      if (covered(time) && worker && !staleOpening) { pump(); return; }
      // Cancel obsolete work immediately, including an open that would later
      // clear buffers covering the latest target. WebKit can coalesce seeking
      // events, so read the final currentTime again when the debounce expires.
      stopWorker();
      seekTimer = setTimeout(() => {
        seekTimer = null;
        if (!destroyed && !legacy) void start(Math.min(video.currentTime, duration - .1));
      }, 30);
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
        video.addEventListener('seeked', seek);
        video.addEventListener('timeupdate', pump);
        timer = setInterval(pump, 250);
        mediaSource.addEventListener('sourceopen', () => void start(0), { once: true });
      },
      unload() { clearTimeout(seekTimer); seekTimer = null; stopWorker(); legacy?.unload(); },
      detachMediaElement() { legacy?.detachMediaElement(); },
      destroy() {
        destroyed = true;
        stopWorker();
        clearInterval(timer); clearTimeout(seekTimer);
        video?.removeEventListener('seeking', seek);
        video?.removeEventListener('seeked', seek);
        video?.removeEventListener('timeupdate', pump);
        legacy?.destroy();
        URL.revokeObjectURL(objectUrl);
        buffers.clear(); allocations.length = 0; handlers.clear();
      }
    };
  }
  global.TCloudRemux = Object.freeze({ createPlayer });
})(globalThis);
