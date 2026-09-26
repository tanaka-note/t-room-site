import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Disposable macOS CI only. Read the explicitly configured virtual output,
// never a microphone or a user's default input. PCM stays in bounded RAM.
export async function captureFixtureAudio(ffmpeg) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.TROOM_AUDIO_LOOPBACK, 'BlackHole 2ch');
  const pcm = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-probesize', '32', '-f', 'avfoundation',
      '-i', ':BlackHole 2ch', '-af', 'aresample=44100,asetnsamples=n=44100:p=0,asetpts=N/SR/TB',
      '-frames:a', '1', '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1']);
    const chunks = []; let size = 0, stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Loopback capture did not finish: ${stderr}`)); }, 10000);
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
  return measureFixturePcm(pcm);
}

export function measureFixturePcm(pcm) {
  assert.ok(pcm.length >= 44100 * 4 * .9, `capture contains at least 0.9s of real PCM (${pcm.length} bytes)`);
  let energy = 0, peak = 0;
  const samples = [];
  for (let offset = 0; offset + 4 <= pcm.length; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    assert.ok(Number.isFinite(sample), 'PCM samples are finite');
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
    samples.push(sample);
  }
  const seconds = pcm.length / 4 / 44100;
  // Lossy codecs and pitch preservation add small zero crossings. Measure the
  // dominant spectral tone instead; require substantial signal energy in it.
  let frequency = 0, strongest = 0;
  // Average overlapping short windows so capture clock discontinuities and
  // pitch-preserving playback cannot cancel a real tone across the whole second.
  const windowSize = 4096;
  const windows = [];
  let windowEnergy = 0;
  for (let start = 0; start + windowSize <= samples.length; start += windowSize / 2) {
    const window = samples.slice(start, start + windowSize);
    windowEnergy += window.reduce((sum, sample) => sum + sample * sample, 0);
    windows.push(window.map((sample, i) => sample * (.5 - .5 * Math.cos(2 * Math.PI * i / (windowSize - 1)))));
  }
  for (let hz = 100; hz <= 1500; hz += 2) {
    const coefficient = 2 * Math.cos(2 * Math.PI * hz / 44100);
    let power = 0;
    for (const window of windows) {
      let previous = 0, older = 0;
      for (const sample of window) {
        const next = sample + coefficient * previous - older;
        older = previous; previous = next;
      }
      power += previous * previous + older * older - coefficient * previous * older;
    }
    if (power > strongest) { strongest = power; frequency = hz; }
  }
  const toneFraction = windowEnergy ? 2 * strongest / (windowSize * windowEnergy) : 0;
  return { seconds, rms: Math.sqrt(energy / samples.length), peak, frequency, toneFraction };
}

export async function verifyFixtureAudioOutput(page, ffmpeg) {
  const quiet = await captureFixtureAudio(ffmpeg);
  assert.ok(quiet.rms < .001, 'muted/paused fixture output is silent before playback');
  await page.evaluate(() => {
    __video.muted = false;
    return Promise.race([__video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Loopback fixture play did not resolve')), 10000))]);
  });
  const before = await page.evaluate(() => __video.currentTime);
  try {
    const audible = await captureFixtureAudio(ffmpeg);
    assert.ok(audible.rms > .001, `browser outputs actual PCM: ${JSON.stringify(audible)}`);
    assert.ok(Math.abs(audible.frequency - 440) < 20, `output contains the synthetic 440Hz fixture tone: ${JSON.stringify(audible)}`);
    assert.ok(audible.toneFraction > .1, `fixture tone accounts for substantial output energy: ${JSON.stringify(audible)}`);
    assert.ok(await page.evaluate(time => __video.currentTime > time + .2 && !__video.paused, before), 'audio is measured during advancing playback');
    console.log('PASS native audio output PCM', JSON.stringify(audible));
  } finally { await page.evaluate(() => __video.pause()); }
}
