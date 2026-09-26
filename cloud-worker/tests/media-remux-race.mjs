import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(process.env.TROOM_REMUX_SOURCE || new URL('../public/media-remux.js', import.meta.url), 'utf8');
function fixture() {
  const workers = [], timers = new Map();
  let nextTimer = 0, mediaSource, fallback = 0;
  class SourceBuffer extends EventTarget {
    updating = false;
    ranges = [];
    removals = [];
    get buffered() { return { length: this.ranges.length, start: i => this.ranges[i][0], end: i => this.ranges[i][1] }; }
    appendBuffer() { assert.equal(this.updating, false); this.updating = true; queueMicrotask(() => this.release()); }
    remove(start, end) { assert.equal(this.updating, false); this.removals.push([start, end]); this.ranges = []; this.updating = true; queueMicrotask(() => this.release()); }
    release() { this.updating = false; this.dispatchEvent(new Event('updateend')); }
  }
  class MediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    readyState = 'open';
    buffers = [];
    constructor() { super(); mediaSource = this; }
    addSourceBuffer() { const buffer = new SourceBuffer(); this.buffers.push(buffer); return buffer; }
  }
  class Worker {
    messages = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(data) { this.messages.push(data); }
    terminate() { this.terminated = true; }
    deliver(data) { return this.onmessage({ data }); }
  }
  const context = vm.createContext({
    MediaSource, Worker,
    URL: class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} },
    location: { href: 'http://localhost/cloud/', origin: 'http://localhost' },
    mpegts: { Events: { ERROR: 'error' }, createPlayer() { fallback++; throw new Error('Unexpected fallback'); } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++nextTimer; }, clearInterval() {}
  });
  vm.runInContext(source, context);
  const video = new EventTarget(); video.currentTime = 22.5;
  const player = context.TCloudRemux.createPlayer({ url: '/cloud/local-media/fixture', filesize: 4 * 1024 * 1024, type: 'flv' }, {});
  player.on('error', () => { throw new Error('Unexpected player error'); });
  player.attachMediaElement(video); player.load();
  mediaSource.dispatchEvent(new Event('sourceopen'));
  const ready = () => ({ type: 'ready', duration: 90, tracks: [{ type: 'video', mime: 'video/mp4', init: new Uint8Array([1]) }] });
  const seek = (time, notify = true) => { video.currentTime = time; if (notify) video.dispatchEvent(new Event('seeking')); };
  const flush = () => { for (const [id, timer] of [...timers]) if (timer.delay === 30) { timers.delete(id); timer.callback(); } };
  return { player, video, workers, mediaSource, ready, seek, flush, fallback: () => fallback };
}
async function loaded() {
  const f = fixture();
  await f.workers[0].deliver(f.ready());
  f.mediaSource.buffers[0].ranges = [[20, 48]];
  await f.workers[0].deliver({ type: 'data', fragments: [{ type: 'video', bytes: new Uint8Array([2]) }], end: 48, eof: false });
  return f;
}

for (const notify of [true, false]) {
  const f = await loaded();
  f.seek(36); f.seek(54); f.seek(45, notify); f.flush();
  assert.equal(f.workers[0].terminated, true, 'obsolete reader stops immediately');
  assert.equal(f.workers.at(-1).messages[0].time, 45, 'latest target wins, including a coalesced seeking event');
  assert.equal(f.fallback(), 0);
  f.player.destroy();
}

{
  const f = await loaded();
  f.seek(54); f.flush();
  const current = f.workers.at(-1);
  f.mediaSource.buffers[0].ranges = [];
  f.video.dispatchEvent(new Event('seeked'));
  f.flush();
  assert.equal(current.terminated, false, 'current target reader continues while track buffers are still filling');
  assert.equal(f.workers.at(-1), current);
  f.player.destroy();
}

{
  const f = await loaded();
  f.seek(54); f.flush(); // The old open has already started before the final target.
  const obsolete = f.workers.at(-1);
  f.seek(45, false); // WebKit coalesces the second seeking notification.
  f.video.dispatchEvent(new Event('seeked'));
  f.flush();
  assert.equal(obsolete.terminated, true, 'settled coalesced seek cancels an already opening reader');
  assert.equal(f.workers.at(-1).messages[0].time, 45);
  f.player.destroy();
}

{
  const f = await loaded();
  f.seek(54); f.flush();
  const obsolete = f.workers.at(-1), buffer = f.mediaSource.buffers[0];
  buffer.updating = true;
  const queuedRemoval = obsolete.deliver(f.ready());
  f.seek(45); // Still covered by the old buffer while the new reader opens.
  assert.equal(obsolete.terminated, true);
  buffer.release(); await queuedRemoval;
  assert.deepEqual(buffer.ranges, [[20, 48]], 'superseded ready handler must not erase the usable range after awaiting updateend');
  assert.equal(buffer.removals.length, 0);
  f.flush();
  assert.equal(f.workers.at(-1).messages[0].time, 45);
  assert.equal(f.fallback(), 0);
  f.player.destroy();
}
console.log('PASS remux latest seek, coalesced event, and superseded SourceBuffer mutation');
