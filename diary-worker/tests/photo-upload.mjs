import assert from 'node:assert/strict';
import { createPhotoUploadManager } from '../public/diary-photo-upload.js';

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
const realWarn = console.warn;
let waits = [], diagnostics = [], timers = new Map(), timerId = 0;
globalThis.window = {
  setTimeout(fn, ms) {
    const id = ++timerId;
    if (ms >= 180000 || ms === 10000) timers.set(id, fn);
    else { waits.push(ms); queueMicrotask(fn); }
    return id;
  },
  clearTimeout(id) { timers.delete(id); }
};
console.warn = (...args) => diagnostics.push(args);
const response = (status, value, headers) => new Response(JSON.stringify(value), { status, headers });
function fixture(handler) {
  waits = []; diagnostics = []; timers.clear();
  const state = { photoUploadActiveTasks: new Set(), photoUploadPendingCount: 0, editorPhotos: [] };
  const manager = createPhotoUploadManager({ state, basePath: '/diary', getTargetEntryId: () => null,
    api: async () => ({ uploadSession: { id: crypto.randomUUID() } }) });
  globalThis.fetch = handler;
  const photo = (bytes = 16) => ({ id: crypto.randomUUID(), fileName: 'private-name.jpg',
    originalFile: new File([new Uint8Array(bytes)], 'private-name.jpg', { type: 'image/jpeg' }),
    displayBlob: new Blob(['display']), thumbnailBlob: new Blob(['thumb']) });
  return { state, manager, photo };
}
try {
  for (const mode of ['normal', 'network', 'lost', 'invalid', '503', '429', '408', 'timeout']) {
    let posts = 0, gets = 0, stored = false, id;
    const { manager, photo } = fixture(async (url, init) => {
      if (init.method !== 'POST') { gets++; return response(stored ? 200 : 404, { photo: { id: stored ? id : null } }); }
      posts++; id = init.body.get('id');
      if (posts === 1) {
        if (mode === 'timeout') {
          return new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
            [...timers.values()][0]();
          });
        }
        if (mode === 'network') throw new TypeError('offline');
        if (mode === 'lost') { stored = true; throw new TypeError('lost'); }
        if (mode === 'invalid') { stored = true; return new Response('{', { status: 200 }); }
        if (['503', '429', '408'].includes(mode)) return response(Number(mode), {}, { 'Retry-After': '2' });
      }
      stored = true;
      return response(200, { photo: { id } });
    });
    const p = photo();
    await manager.queueBackgroundPhotoUpload(p);
    assert.equal(p.uploadState, 'uploaded', mode);
    assert.equal(posts, ['normal', 'lost', 'invalid'].includes(mode) ? 1 : 2, mode);
    if (['lost', 'invalid'].includes(mode)) assert.equal(gets, 1, mode);
    if (['503', '429'].includes(mode)) assert.ok(waits[0] >= 1900, mode);
    assert.equal(p.originalFile, null);
    await manager.ensurePhotosUploaded([p]);
    assert.equal(posts, ['normal', 'lost', 'invalid'].includes(mode) ? 1 : 2);
    assert.ok(!JSON.stringify(diagnostics).includes('private-name'));
  }
  for (const status of [400, 401, 403, 413]) {
    let posts = 0;
    const { manager, photo } = fixture(async () => { posts++; return response(status, { error: 'rejected' }); });
    const p = photo();
    await manager.queueBackgroundPhotoUpload(p);
    assert.equal(posts, 1, `${status}: no automatic retries`);
    assert.equal(p.uploadState, 'failed');
    assert.ok(p.originalFile instanceof File, 'retain failed payload');
    assert.equal(waits.length, 0);
  }
  for (const retryAfter of ['120', new Date(Date.now() + 120000).toUTCString()]) {
    let posts = 0;
    const { manager, photo } = fixture(async () => {
      posts++;
      return response(429, {}, { 'Retry-After': retryAfter });
    });
    const p = photo();
    await manager.queueBackgroundPhotoUpload(p);
    assert.equal(posts, 1);
    await assert.rejects(manager.ensurePhotosUploaded([p]));
    assert.equal(posts, 1, 'manual retry must respect a long server cooldown without waiting indefinitely');
    assert.equal(waits.length, 0);
  }
  {
    let posts = 0;
    const { manager, photo } = fixture(async (url, init) => {
      if (init.method !== 'POST') return response(403, {});
      posts++; throw new TypeError('lost');
    });
    const p = photo();
    await manager.queueBackgroundPhotoUpload(p);
    assert.equal(posts, 1, 'reconciliation authorization failure must stop retries');
    assert.equal(p.uploadError.status, 403);
  }
  {
    let posts = 0;
    const { manager, photo } = fixture(async (url, init) => {
      if (init.method !== 'POST') return response(404, {});
      posts++; throw new TypeError('offline');
    });
    const p = photo();
    const uploading = manager.queueBackgroundPhotoUpload(p);
    await assert.rejects(manager.ensurePhotosUploaded([p]));
    await uploading;
    assert.equal(posts, 4, 'save while uploading must not silently double the retry budget');
    assert.equal(waits.length, 3);
    assert.ok(waits[1] > waits[0] && waits[2] > waits[1]);
    assert.ok(p.originalFile instanceof File);
    globalThis.fetch = async (url, init) => {
      assert.notEqual(init.method, 'POST', 'manual retry confirms a late successful upload without resending');
      return response(200, { photo: { id: p.id } });
    };
    await manager.ensurePhotosUploaded([p]);
    assert.equal(p.uploadState, 'uploaded');
  }
  for (const bytes of [16, 9 * 1024 * 1024]) {
    let active = 0, max = 0;
    const { manager, photo } = fixture(async (url, init) => {
      active++; max = Math.max(active, max);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return response(200, { photo: { id: init.body.get('id') } });
    });
    const photos = [photo(bytes), photo(bytes), photo(bytes)];
    await Promise.all(photos.map(p => manager.queueBackgroundPhotoUpload(p)));
    assert.equal(max, bytes === 16 ? 2 : 1, 'parallel byte budget');
    assert.ok(photos.every(p => p.uploadState === 'uploaded'));
  }
  console.log('Photo upload retries, timeout, response reconciliation, non-retryable errors, payload retention and byte budget passed.');
} finally {
  globalThis.fetch = realFetch; globalThis.window = realWindow; console.warn = realWarn;
}
