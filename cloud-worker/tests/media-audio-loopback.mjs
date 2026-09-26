import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Disposable macOS CI only. Read the explicitly configured virtual output,
// never a microphone or a user's default input. PCM stays in bounded RAM.
export async function captureFixtureAudio(ffmpeg) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.TROOM_AUDIO_LOOPBACK, 'BlackHole 2ch');
  const pcm = await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
      '-i', ':BlackHole 2ch', '-t', '1', '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1']);
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
  assert.ok(pcm.length >= 44100 * 4 * .9, 'capture contains at least 0.9s of real PCM');
  let energy = 0, peak = 0, crossings = 0, previous = 0;
  for (let offset = 0; offset + 4 <= pcm.length; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    assert.ok(Number.isFinite(sample), 'PCM samples are finite');
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
    if (previous <= 0 && sample > 0) crossings++;
    previous = sample;
  }
  const seconds = pcm.length / 4 / 44100;
  return { seconds, rms: Math.sqrt(energy / (pcm.length / 4)), peak, frequency: crossings / seconds };
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
    assert.ok(await page.evaluate(time => __video.currentTime > time + .2 && !__video.paused, before), 'audio is measured during advancing playback');
    console.log('PASS native audio output PCM', JSON.stringify(audible));
  } finally { await page.evaluate(() => __video.pause()); }
}
