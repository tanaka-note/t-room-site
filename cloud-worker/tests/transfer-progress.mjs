import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../public/transfer-progress.js';

const transfer = globalThis.TCloudTransfer;
function fixture(files) {
  let time = 1000, tick, cleared = false;
  const views = [], completions = [];
  const tracker = transfer.createTracker(files, files.reduce((sum, file) => sum + file.size, 0), {
    formatBytes: bytes => `${bytes} B`,
    render: view => views.push(view),
    completed: (...args) => completions.push(args),
    now: () => time,
    setInterval(callback, delay) { assert.equal(delay, 1000); tick = callback; return 7; },
    clearInterval(id) { assert.equal(id, 7); cleared = true; }
  });
  return { tracker, views, completions, latest: () => views.at(-1), advance(ms) { time += ms; tick(); }, cleared: () => cleared };
}

test('multipart retries reset logical progress without counting retransmitted bytes twice', () => {
  const file = { name: 'movie.mp4', size: 1000 }, f = fixture([file]);
  f.tracker.start(file);
  f.tracker.partProgress(file, 1, 1, 250, 500);
  assert.equal(f.latest().width, '25%');
  f.tracker.retry(file, 1, 2, 4);
  assert.equal(f.latest().width, '0%');
  assert.equal(f.latest().waiting, true);
  f.advance(1000);
  f.tracker.partProgress(file, 1, 2, 500, 500);
  f.tracker.partProgress(file, 1, 0, 500, 500, true);
  f.tracker.partProgress(file, 1, 2, 100, 500);
  assert.equal(f.latest().width, '50%');
  assert.equal(f.latest().bytes, '500 B / 1000 B');
  f.tracker.partProgress(file, 2, 1, 500, 500);
  f.tracker.finish(file, 1);
  assert.equal(f.latest().width, '100%');
  assert.equal(f.latest().eta, '送信完了');
  assert.deepEqual(f.completions, [[1, 1]]);
});

test('deferred files restart progress and an idle transfer reports waiting', () => {
  const file = { name: 'photo.jpg', size: 100 }, f = fixture([file]);
  f.tracker.start(file);
  f.tracker.partProgress(file, 1, 1, 50, 100);
  f.advance(16000);
  assert.equal(f.latest().waiting, true);
  assert.match(f.latest().activity, /通信応答待ち/);
  f.tracker.defer(file);
  assert.equal(f.latest().width, '0%');
  f.tracker.start(file);
  f.tracker.phase(file, '暗号化準備中…');
  assert.equal(f.latest().activity, '暗号化準備中');
  f.tracker.stop();
  const count = f.views.length;
  f.advance(1000);
  assert.equal(f.views.length, count);
  assert.equal(f.cleared(), true);
});

test('limiter caps concurrent work and releases its slot after a failure', async () => {
  const limit = transfer.createLimiter(2), gates = [], started = [];
  const tasks = [0, 1, 2, 3].map(id => limit(async () => {
    started.push(id);
    await new Promise(resolve => { gates[id] = resolve; });
    if (id === 0) throw new Error('fixture failure');
    return id;
  }));
  const results = Promise.allSettled(tasks);
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1]);
  gates[0]();
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2]);
  gates[1]();
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2](); gates[3]();
  assert.deepEqual((await results).map(result => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(limit.limit, 2);
  assert.equal(transfer.connectionLimitForFile(6, 2), 3);
  assert.equal(transfer.connectionLimitForFile(6, 1), 6);
});
