import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Disposable macOS CI only. Read the explicitly configured virtual output,
// never a microphone or a user's default input. PCM stays in bounded RAM.
export async function captureFixtureAudio(ffmpeg, timeoutMs = 10000) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.TROOM_AUDIO_LOOPBACK, 'BlackHole 2ch');
  const nativeCapture = process.env.TROOM_AUDIO_CAPTURE_BIN;
  assert.ok(nativeCapture, 'a calibrated native CoreAudio recorder is required');
  const pcm = await new Promise((resolve, reject) => {
    const child = spawn(nativeCapture, []);
    const chunks = []; let size = 0, stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Loopback capture did not finish: ${stderr}`)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) { child.kill('SIGKILL'); reject(new Error('Loopback capture exceeded bounded PCM budget')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Loopback capture failed (${code}): ${stderr}`));
      else resolve(Buffer.concat(chunks));
    });
  });
  const boundary = pcm.indexOf(10);
  assert.ok(boundary > 0 && boundary < 256, 'native PCM metadata is bounded');
  const metadata = JSON.parse(pcm.subarray(0, boundary).toString('utf8'));
  assert.equal(metadata.device, 'BlackHole 2ch');
  assert.equal(metadata.channels, 2);
  assert.ok([44100, 48000].includes(metadata.sampleRate), 'actual device sample rate is supported');
  return measureFixturePcm(pcm.subarray(boundary + 1), metadata.sampleRate);
}

async function captureAudibleFixtureAudio(ffmpeg) {
  // Match the existing 10s real-PCM gate: decoder/device startup and a rate
  // change may initially produce silence. Never retry errors or wrong content.
  const deadline = performance.now() + 10000;
  let capture;
  do {
    capture = await captureFixtureAudio(ffmpeg, Math.max(1, deadline - performance.now()));
    if (capture.rms > .001) return capture;
  } while (performance.now() < deadline);
  assert.ok(capture.rms > .001, `actual PCM did not arrive within 10s: ${JSON.stringify(capture)}`);
}

export function measureFixturePcm(pcm, sampleRate = 44100) {
  assert.ok(pcm.length >= sampleRate * 4 * .9, `capture contains at least 0.9s of real PCM (${pcm.length} bytes)`);
  let energy = 0, peak = 0;
  const samples = [];
  for (let offset = 0; offset + 4 <= pcm.length; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    assert.ok(Number.isFinite(sample), 'PCM samples are finite');
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
    samples.push(sample);
  }
  const seconds = pcm.length / 4 / sampleRate;
  // Lossy codecs and pitch preservation add small zero crossings. Measure the
  // dominant spectral tone and the actual fraction of energy in its band.
  let frequency = 0, strongest = 0;
  // Average overlapping short windows so capture clock discontinuities and
  // pitch-preserving playback cannot cancel a real tone across the whole second.
  const windowSize = 4096;
  const windows = [];
  let windowEnergy = 0, tonePower = 0;
  for (let start = 0; start + windowSize <= samples.length; start += windowSize / 2) {
    const window = samples.slice(start, start + windowSize);
    const weighted = window.map((sample, i) => sample * (.5 - .5 * Math.cos(2 * Math.PI * i / (windowSize - 1))));
    windowEnergy += weighted.reduce((sum, sample) => sum + sample * sample, 0);
    windows.push(weighted);
  }
  // Integer DFT bins permit Parseval energy accounting, unlike the old
  // single-bin peak estimate (whose maximum was only 0.25 after windowing).
  for (let bin = Math.ceil(100 * windowSize / sampleRate); bin <= Math.floor(1500 * windowSize / sampleRate); bin++) {
    const hz = bin * sampleRate / windowSize;
    const coefficient = 2 * Math.cos(2 * Math.PI * hz / sampleRate);
    let power = 0;
    for (const window of windows) {
      let previous = 0, older = 0;
      for (const sample of window) {
        const next = sample + coefficient * previous - older;
        older = previous; previous = next;
      }
      power += previous * previous + older * older - coefficient * previous * older;
    }
    if (hz >= 400 && hz <= 480) tonePower += power;
    if (power > strongest) { strongest = power; frequency = hz; }
  }
  const toneFraction = windowEnergy ? 2 * tonePower / (windowSize * windowEnergy) : 0;
  return { seconds, rms: Math.sqrt(energy / samples.length), peak, frequency, toneFraction };
}

export async function calibrateFixtureAudioOutput(ffmpeg = 'ffmpeg') {
  const quiet = await captureFixtureAudio(ffmpeg);
  assert.ok(quiet.rms < .001, 'loopback calibration starts with silent output');
  const child = spawn('ffplay', ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=10'],
  { env: { ...process.env, SDL_AUDIODRIVER: 'coreaudio' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Calibration output did not finish')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Calibration output failed (${code}): ${stderr}`)); });
  });
  // Attach immediately; a device startup error must not become an unhandled
  // promise rejection while the independently bounded capture is in progress.
  const producer = completed.then(() => ({ ok: true }), error => ({ error }));
  const tone = await captureAudibleFixtureAudio(ffmpeg);
  const output = await producer;
  if (output.error) throw output.error;
  assert.ok(tone.rms > .001, `known producer has real output PCM: ${JSON.stringify(tone)}`);
  assert.ok(Math.abs(tone.frequency - 440) < 20, `capture measures known 440Hz producer correctly: ${JSON.stringify(tone)}`);
  assert.ok(tone.toneFraction > .5, `known producer has expected tone energy: ${JSON.stringify(tone)}`);
  console.log('PASS independent loopback calibration', JSON.stringify(tone));
}

export async function verifyFixtureAudioOutput(page, ffmpeg) {
  const quiet = await captureFixtureAudio(ffmpeg);
  assert.ok(quiet.rms < .001, 'muted/paused fixture output is silent before playback');
  await page.evaluate(() => {
    __video.muted = false;
    return Promise.race([__video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Loopback fixture play did not resolve')), 10000))]);
  });
  const before = await page.evaluate(() => __video.currentTime);
  const rate = await page.evaluate(() => __video.playbackRate);
  try {
    const audible = await captureAudibleFixtureAudio(ffmpeg);
    assert.ok(audible.rms > .001, `browser outputs actual PCM: ${JSON.stringify(audible)}`);
    assert.ok(await page.evaluate(time => __video.currentTime > time + .2 && !__video.paused, before), 'audio is measured during advancing playback');
    // The calibrated HAL capture identifies the tone at the original tested
    // 1.5x rate. It needs no compensating rate mutation for the old recorder.
    assert.ok(Math.abs(audible.frequency - 440) < 20, `output contains the synthetic 440Hz fixture tone: ${JSON.stringify(audible)}`);
    assert.ok(audible.toneFraction > .5, `fixture tone accounts for most output energy: ${JSON.stringify(audible)}`);
    console.log('PASS native audio output PCM/tone at tested playback rate', rate, JSON.stringify(audible));
  } finally { await page.evaluate(() => __video.pause()); }
}
