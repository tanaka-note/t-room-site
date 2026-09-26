import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'tcloud-seek-'));
const ffmpeg = process.env.TROOM_FFMPEG || 'ffmpeg';
function generate(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Seek fixture generation failed: ${result.error || result.stderr}`);
}
const mp4 = join(scratch, 'sample.mp4');
generate(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mp4]);
for (const ext of ['ts', 'mov', 'flv']) generate(['-i', mp4, '-c', 'copy', ...(ext === 'flv' ? ['-flvflags', 'add_keyframe_index'] : []), join(scratch, `sample.${ext}`)]);
generate(['-i', mp4, '-c', 'copy', '-f', 'flv', join(scratch, 'sample.flv-unindexed')]);
// Add standard M2TS arrival timestamps while preserving the AVC/AAC PMT.
// FFmpeg's Blu-ray mode instead marks AAC as unidentified private data.
const transport = readFileSync(join(scratch, 'sample.ts'));
assert.equal(transport.length % 188, 0);
const m2ts = Buffer.alloc(transport.length / 188 * 192);
for (let offset = 0; offset < transport.length; offset += 188) {
  const output = offset / 188 * 192;
  m2ts.writeUInt32BE(offset / 188, output);
  transport.copy(m2ts, output + 4, offset, offset + 188);
}
writeFileSync(join(scratch, 'sample.m2ts'), m2ts);
generate(['-i', mp4, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', '-c:a', 'libvorbis', join(scratch, 'sample.webm')]);
const cases = [
  ['mp4', 'mp4', 'video/mp4', 'native'], ['webm', 'webm', 'video/webm', 'native'],
  ['mov', 'mov', 'video/quicktime', 'native'], ['ts', 'ts', 'video/mp2t', 'remux'],
  ['m2ts', 'm2ts', 'video/mp2t', 'remux'], ['flv', 'flv', 'video/x-flv', 'remux'],
  ['flv-no-index', 'flv-unindexed', 'video/x-flv', 'remux'],
  ['disguised-mp4', 'ts', 'video/mp4', 'remux'], ['disguised-ts', 'mp4', 'video/mp2t', 'native']
];
const bytes = new Map(cases.map(([id, ext]) => [id, readFileSync(join(scratch, `sample.${ext}`))]));
const requests = [];
const fixture = await startUIFixture(undefined, { handleRequest(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const id = path.startsWith('/cloud/local-media/seek-') ? path.slice('/cloud/local-media/seek-'.length) : '';
  if (!bytes.has(id)) return false;
  const body = bytes.get(id), range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0, end = Math.min(body.length - 1, range?.[2] ? Number(range[2]) : body.length - 1);
  requests.push({ id, start, end, range: Boolean(range), header: req.headers.range });
  if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end(); return true; }
  res.writeHead(range ? 206 : 200, { 'Content-Type': cases.find(item => item[0] === id)[2], 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
  // Avoid letting a tiny fixture hide seeks outside the current MSE buffer.
  let offset = start;
  const timer = setInterval(() => {
    const next = Math.min(end + 1, offset + 65536);
    res.write(body.subarray(offset, next)); offset = next;
    if (offset > end) { clearInterval(timer); res.end(); }
  }, 10);
  res.on('close', () => clearInterval(timer));
  return true;
} });

async function seek(page, target) {
  await page.evaluate(time => {
    globalThis.__events = { seeking: 0, seeked: 0, timeupdate: 0 };
    for (const name of Object.keys(__events)) __video.addEventListener(name, () => __events[name]++, { once: true });
    __video.currentTime = time;
  }, target);
  await page.waitForFunction(time => !__video.seeking && Math.abs(__video.currentTime - time) < .3 && __video.readyState >= 2 && __events.seeking && __events.seeked && __events.timeupdate, target, { timeout: 25000 });
  await page.evaluate(() => Promise.race([
    __video.play(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Playback did not resume after seek')), 10000))
  ]));
  const before = await page.evaluate(() => __video.currentTime);
  await page.waitForFunction(time => __video.currentTime > time + .2, before, { timeout: 10000 });
  await page.evaluate(() => __video.pause());
}

try {
  for (const [engineName, engine, launch] of engines) {
    const browser = await engine.launch({ headless: true, ...launch });
    try {
      for (const [shared, touch] of process.argv.includes('--share-only') ? [[true, true]] : [[false, false], [true, true]]) {
        for (const [id, ext, mime, route] of cases.filter(item => !process.env.TROOM_SEEK_CASE || item[0] === process.env.TROOM_SEEK_CASE)) {
          const context = await browser.newContext({ viewport: touch ? { width: 390, height: 740 } : { width: 1280, height: 900 }, hasTouch: touch });
          const page = await context.newPage();
          const workers = new Set();
          page.on('worker', worker => { workers.add(worker); worker.on('close', () => workers.delete(worker)); });
          await page.route('**/cloud/api/**', route => route.fulfill({ json: {} }));
          const file = { id: 2, name: `${id}.${id === 'disguised-mp4' ? 'mp4' : id === 'disguised-ts' ? 'ts' : id === 'flv-no-index' ? 'flv' : ext}`, mediaKind: 'video', mimeType: mime, createdAt: '2026-09-26 00:00:00', sizeBytes: bytes.get(id).length, hasThumbnail: true };
          const url = `${fixture.origin}/cloud/local-media/seek-${id}`;
          if (shared) {
            await page.goto(`${fixture.origin}/cloud/share/${'A'.repeat(43)}`);
            await page.waitForFunction(() => globalThis.__share);
            await page.evaluate(({ file, url }) => { __share.bindEvents(); __share.videoFixture(url); __share.prepare([file]); __share.renderSortedItems(); }, { file, url });
          } else {
            await preparePage(page, fixture.origin, 2);
            await page.evaluate(({ file, url }) => { Object.assign(__test.state.files[1], file); __test.videoFixture(url); }, { file, url });
          }
          await page.evaluate(() => { globalThis.TCloudMedia = { ...TCloudMedia, updateMediaFormat: async () => true, markPlaying() {} }; });
          await page.locator(shared ? '#items .file > button:first-child' : '.file-card[data-file-id="2"] > button:first-child').click();
          await page.waitForSelector('#preview-stage video');
          await page.evaluate(() => { globalThis.__video = document.querySelector('video'); __video.muted = true; });
          // Missing codecs/MSE are failures, never a silent skip of a seek case.
          await page.waitForFunction(() => Number.isFinite(__video.duration) && __video.duration > 80 && __video.readyState >= 2, null, { timeout: 25000 }).catch(async error => {
            console.error('RANGES', requests.filter(request => request.id === id));
            console.error('MEDIA STATE', engineName, id, await page.evaluate(() => ({ duration: __video.duration, readyState: __video.readyState, error: __video.error?.code, networkState: __video.networkState, src: __video.src, stage: document.querySelector('#preview-stage')?.textContent })));
            throw error;
          });
          assert.equal(await page.evaluate(() => __video.src.startsWith('blob:')), route !== 'native', `${engineName}/${id}: native-first route`);
          const duration = await page.evaluate(() => __video.duration);
          if (route === 'remux') assert.ok(await page.evaluate(() => __video.buffered.end(__video.buffered.length - 1)) < duration * .75, 'forward seek must cross the unbuffered region');
          await seek(page, duration * .25);
          await seek(page, duration * .75);
          await seek(page, duration * .25);
          await page.evaluate(duration => { __video.currentTime = duration * .4; __video.currentTime = duration * .6; }, duration);
          await seek(page, duration * .5);
          await seek(page, duration - 1);
          await seek(page, duration * .25);
          await page.evaluate(() => { __video.volume = .4; __video.playbackRate = 1.5; });
          assert.deepEqual(await page.evaluate(() => [__video.volume, __video.playbackRate, __video.disableRemotePlayback]), [.4, 1.5, true]);
          if (engineName === 'chromium') assert.ok(await page.evaluate(() => __video.webkitAudioDecodedByteCount) > 0, `${id}: real audio is decoded`);
          if (engineName === 'webkit') {
            // WebKit exposes no decoded-byte counter. Observe actual PCM from
            // the media element, with a silent destination to avoid test sound.
            await page.evaluate(async () => {
              globalThis.__audio = new AudioContext();
              globalThis.__analyser = __audio.createAnalyser();
              const source = __audio.createMediaElementSource(__video);
              const silent = __audio.createGain(); silent.gain.value = 0;
              source.connect(__analyser); __analyser.connect(silent); silent.connect(__audio.destination);
              __video.muted = false;
              await Promise.race([
                (async () => { await __audio.resume(); await __video.play(); })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('WebKit audio did not start')), 10000))
              ]);
            });
            await page.waitForFunction(() => {
              const pcm = new Float32Array(__analyser.fftSize);
              __analyser.getFloatTimeDomainData(pcm);
              return pcm.some(value => Math.abs(value) > .001);
            }, null, { timeout: 10000 });
            await page.evaluate(async () => { __video.pause(); await __audio.close(); });
          }
          await page.locator(shared ? '#preview-dialog .close' : '#preview-close').click();
          await page.waitForFunction(() => !document.querySelector('video'));
          assert.equal(workers.size, 0, 'closing preview terminates remux workers');
          await context.close();
          console.log(`PASS real seek/events/resume/audio/cleanup ${engineName} ${shared ? 'share/mobile' : 'normal/desktop'} ${id}`);
        }
      }
      const guarded = await browser.newPage();
      await preparePage(guarded, fixture.origin, 0);
      for (const source of ['https://example.invalid/plain-video', `${fixture.origin}/cloud/api/files/1/view`]) {
        assert.equal(await guarded.evaluate(async url => {
          const worker = new Worker('/cloud/media-remux-worker.mjs', { type: 'module' });
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Local-source guard timeout')), 10000);
              worker.onmessage = ({ data }) => { clearTimeout(timer); resolve(data.type); };
              worker.onerror = reject;
              worker.postMessage({ type: 'open', url, size: 100 });
            });
          } finally { worker.terminate(); }
        }, source), 'error', 'the worker rejects remote/direct API plaintext sources');
        assert.equal(await guarded.evaluate(url => {
          const player = TCloudRemux.createPlayer({ url, filesize: 100 }, {});
          let failed = false;
          player.on(mpegts.Events.ERROR, () => { failed = true; });
          player.attachMediaElement(document.createElement('video'));
          player.load(); player.destroy();
          return failed;
        }, source), true, 'the adapter never passes an unsafe source to legacy fallback');
      }
      await guarded.close();
    } finally { await browser.close(); }
  }
  if (!process.env.TROOM_SEEK_CASE || process.env.TROOM_SEEK_CASE === 'ts') assert.ok(requests.some(request => request.id === 'ts' && request.start > 0), 'TS uses nonzero closed local Range for duration/seek');
} finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }); }
