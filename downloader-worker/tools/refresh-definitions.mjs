import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { ACCOUNT, cloudflareClient, readState, validImage, safeError, delay } from './definition-api.mjs';
import { claimLease } from './definition-lease.mjs';
import { configurationHash, settleObservation, reconcileRollout, saveObservation } from './definition-rollout.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
export function command(args, { input, ...options } = {}) {
  // Async processes allow lease renewal during build/push/verification.
  return new Promise((resolveCommand, reject) => {
    const phase = ['login', 'build', 'run', 'push', 'image'].includes(args[0]) ? args[0] : 'command';
    const failure = () => reject(new Error(`definition_docker_${phase}_failed`));
    const child = spawn('docker', args, { timeout: 20 * 60 * 1000, ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '', bytes = 0;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { child.kill(); failure(); return; }
      stdout += chunk.toString();
    });
    child.on('error', failure);
    child.on('close', code => code === 0 ? resolveCommand(stdout.trim()) : failure());
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function candidateReport(value, now) {
  if (!value?.verified || value.maxAgeSeconds !== 604800 || !Number.isSafeInteger(value.definitionUnix) ||
    value.definitionUnix > now + 300 || now - value.definitionUnix >= 5 * 86400 ||
    !Number.isSafeInteger(value.verifiedAt) || Math.abs(now - value.verifiedAt) > 300) throw new Error('definition_candidate_invalid');
  return value;
}

export function definitionTarget(configuration, image) {
  // GET includes platform-managed runtime/network fields which Containers does
  // not allow callers to set. Submit only the image and existing resource/log
  // settings, as Wrangler does; unspecified deployment settings are retained.
  const target = { image };
  for (const key of ['vcpu', 'memory_mib', 'observability']) {
    if (configuration[key] !== undefined) target[key] = configuration[key];
  }
  if (configuration.disk?.size_mb !== undefined) target.disk = { size_mb: configuration.disk.size_mb };
  return target;
}

export async function refresh({ api = cloudflareClient(), docker = command, now = () => Math.floor(Date.now() / 1000), sleep = delay, maxPolls = 60,
  heartbeatMs = 60000, reconcileOnly = process.env.RECONCILE_ONLY === 'true',
  releaseCode = process.env.RELEASE_CONTAINER_CODE === 'true', analysisOnly = process.env.RELEASE_ANALYSIS_CODE === 'true' } = {}) {
  if (analysisOnly && !releaseCode) throw new Error('definition_analysis_release_requires_code');
  if (reconcileOnly && (releaseCode || analysisOnly)) throw new Error('definition_reconcile_mode_conflict');
  if (reconcileOnly) {
    const row = await readState(api);
    if (!row.pending_image && !row.pending_state) {
      const observed = await settleObservation(api, row, { sleep });
      if (observed.state === 'ready') return { reconciled: true, pending: false };
    }
  }
  const deadline = now() + 38 * 60;
  const lease = await claimLease(api, now, { heartbeatMs });
  const { runId } = lease;
  const dockerConfig = mkdtempSync(join(tmpdir(), 'clamav-registry-'));
  const dockerOptions = { env: { ...process.env, DOCKER_CONFIG: dockerConfig }, signal: lease.signal };
  const run = async args => { await lease.renew(); return docker(args, { ...dockerOptions,
    timeout: Math.min(20 * 60 * 1000, Math.max(1, (deadline - now()) * 1000)) }); };
  let temporaryTag;
  try {
    const initial = await lease.check();
    const resume = () => reconcileRollout({ api, lease, now, target: definitionTarget, sleep, maxPolls, deadline: Math.min(deadline, now() + 30 * 60) });
    // Resume before registry login, build, or any new rollout.
    if (initial.pending_image) return await resume();
    const observed = await settleObservation(api, initial, { sleep });
    if (observed.state !== 'ready') return await saveObservation(lease, initial, observed);
    if (reconcileOnly) {
      await lease.write("last_result='reconciled',pending_state=NULL,pending_rollout_id=NULL");
      return { reconciled: true, pending: false };
    }
    const { app } = observed;
    await lease.write('pending_state=NULL,pending_rollout_id=NULL');
    const oldImage = app.configuration.image;
    if (!validImage(oldImage) || app.rollout_active_grace_period !== 900) throw new Error('definition_application_mismatch');
    // Reuse the code base, not yesterday's refreshed image, to avoid one more
    // 300 MB definition layer every day. Reset the base on ordinary code deploys.
    const source = initial.image === oldImage && validImage(initial.source_image) ? initial.source_image : oldImage;
    const registry = await api('/containers/registries/registry.cloudflare.com/credentials', 'POST', { expiration_minutes: 60, permissions: ['pull', 'push'] });
    await docker(['login', 'registry.cloudflare.com', '--username', registry.username, '--password-stdin'], { ...dockerOptions, input: registry.password });
    temporaryTag = `registry.cloudflare.com/${ACCOUNT}/t-room-downloader-downloadercontainer:definitions-${runId}`;
    if (releaseCode) {
      console.log('Building the explicitly requested repository Container code');
      const context = resolve(directory, '../container');
      await run(['build', '--platform', 'linux/amd64', '-f', analysisOnly ? join(directory, 'analysis.Dockerfile') : join(context, 'Dockerfile'),
        '--build-arg', analysisOnly ? `BASE_IMAGE=${oldImage}` : `CLAMAV_DEFINITION_REFRESH=${runId}`, '-t', temporaryTag, context]);
      console.log('Verifying small local browser fixtures and process cleanup offline');
      // Production run_phase supplies a job-local writable HOME. The direct
      // fixture runner also needs one (the image user's home is /nonexistent).
      await run(['run', '--rm', '--network', 'none', '--cpus', '1', '--memory', '4g', '--entrypoint', 'python', '-e', 'PYTHONPATH=/app', '-e', 'HOME=/work', '-e', 'XDG_CONFIG_HOME=/work', '-e', 'XDG_CACHE_HOME=/work', '-e', 'MAIN_VIDEO_TEST_BROWSER=/usr/bin/chromium', temporaryTag, '-m', 'unittest', 'discover', '-s', '/app/tests', '-p', 'test_main_video.py']);
    } else {
      console.log('Building definition candidate from the deployed code base');
      await run(['build', '--platform', 'linux/amd64', '-f', join(directory, 'definitions.Dockerfile'), '--build-arg', `BASE_IMAGE=${source}`, '--build-arg', `REFRESH_ID=${runId}`, '-t', temporaryTag, directory]);
    }
    console.log(analysisOnly ? 'Rechecking inherited signatures, signed timestamps and rules; engine fixtures unchanged' : 'Verifying candidate signatures, signed timestamps, engine and harmless fixtures');
    const raw = await run(['run', '--rm', '--network', 'none', '--cpus', '1', '--memory', '4g', '--mount', `type=bind,source=${join(directory, 'verify-definitions.py')},target=/tmp/verify-definitions.py,readonly`, '--entrypoint', 'python', '-e', 'PYTHONPATH=/app', temporaryTag, '/tmp/verify-definitions.py', ...(analysisOnly ? ['--definitions-only'] : [])]);
    const report = candidateReport(JSON.parse(raw), now());
    console.log('Pushing verified definition candidate');
    await run(['push', temporaryTag]);
    const digests = JSON.parse(await run(['image', 'inspect', temporaryTag, '--format', '{{json .RepoDigests}}']));
    const image = digests.find(validImage);
    if (!image) throw new Error('definition_digest_missing');
    await lease.renew();
    const before = await settleObservation(api, initial, { sleep });
    if (before.state !== 'ready' || before.app.configuration.image !== oldImage || before.app.version !== app.version ||
      configurationHash(before.app) !== configurationHash(app) ||
      JSON.stringify(before.rollouts.map(r => r.id).sort()) !== JSON.stringify(observed.rollouts.map(r => r.id).sort())) {
      throw new Error('definition_deployment_changed');
    }
    // Persist only verified digests, timestamps, version and hashes/IDs, never credentials.
    await lease.write(`pending_image=?,pending_previous_image=?,pending_source_image=?,pending_definition_unix=?,pending_verified_at=?,
      pending_started_at=?,pending_state='prepared',pending_rollout_id=NULL,pending_attempts=0,pending_reconciliations=0,
      pending_version=?,pending_configuration_hash=?,pending_rollout_ids=?`,
      [image, oldImage, releaseCode ? image : source, report.definitionUnix, report.verifiedAt, now(), app.version,
        configurationHash(before.app), JSON.stringify(before.rollouts.map(r => r.id).sort())]);
    return await resume();
  } catch (error) {
    // Pending intent survives read failures, process loss and uncertain mutations.
    await lease.write(`last_result=CASE WHEN pending_image IS NULL THEN 'failed' ELSE 'rollout_ambiguous' END,
      pending_state=CASE WHEN pending_image IS NULL THEN pending_state ELSE 'rollout_ambiguous' END,
      failure_count=failure_count+1`).catch(() => {});
    throw error;
  } finally {
    // Only our isolated Docker login file; do not touch the user's Docker config.
    try { await lease.release(); } finally { rmSync(dockerConfig, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  refresh().then(result => console.log({ event: 'definition_update_result', state: result.state || (result.image ? 'success' : 'reconciled') }))
    .catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
