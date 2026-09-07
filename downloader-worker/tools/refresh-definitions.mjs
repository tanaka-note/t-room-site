import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { ACCOUNT, APPLICATION_PATH, SECURITY_DB, DOWNLOADER_DB, cloudflareClient, query, readState, validImage, waitForRollout } from './definition-api.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
function command(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, ...options });
  // Subprocess stderr can include registry credentials/URLs. Report fixed codes.
  if (result.status !== 0) {
    // Only this repository-owned, offline fixture suite: its diagnostics do
    // not contain remote URLs, registry credentials, or user content.
    if (args.includes('test_main_video.py')) console.error(String(result.stderr || '').slice(-8000));
    const phase = ['login', 'build', 'run', 'push', 'image'].includes(args[0]) ? args[0] : 'command';
    throw new Error(`definition_docker_${phase}_failed`);
  }
  return result.stdout.trim();
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

export async function refresh({ api = cloudflareClient(), docker = command, now = () => Math.floor(Date.now() / 1000), wait = waitForRollout,
  releaseCode = process.env.RELEASE_CONTAINER_CODE === 'true' } = {}) {
  const runId = `${process.env.GITHUB_RUN_ID || 'manual'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${now()}`;
  const initial = await readState(api);
  const claim = await query(api, SECURITY_DB, `UPDATE security_definition_updates SET run_id=?,lease_until=?,last_attempt_at=?,last_result='running',
    automation_enabled=MAX(automation_enabled,?) WHERE service='downloader' AND (lease_until IS NULL OR lease_until < ?)`,
    [runId, now() + 45 * 60, now(), process.env.GITHUB_ACTIONS === 'true' ? 1 : 0, now()]);
  if (claim.meta.changes !== 1) throw new Error('definition_update_already_running');
  const dockerConfig = mkdtempSync(join(tmpdir(), 'clamav-registry-'));
  const dockerOptions = { env: { ...process.env, DOCKER_CONFIG: dockerConfig } };
  const run = args => docker(args, dockerOptions);
  let temporaryTag;
  try {
    const app = await api(APPLICATION_PATH);
    if (app.active_rollout_id) throw new Error('definition_rollout_busy');
    const oldImage = app.configuration.image;
    if (!validImage(oldImage) || app.rollout_active_grace_period !== 900) throw new Error('definition_application_mismatch');
    // Reuse the code base, not yesterday's refreshed image, to avoid one more
    // 300 MB definition layer every day. Reset the base on ordinary code deploys.
    const source = initial.image === oldImage && validImage(initial.source_image) ? initial.source_image : oldImage;
    const registry = await api('/containers/registries/registry.cloudflare.com/credentials', 'POST', { expiration_minutes: 60, permissions: ['pull', 'push'] });
    docker(['login', 'registry.cloudflare.com', '--username', registry.username, '--password-stdin'], { ...dockerOptions, input: registry.password });
    temporaryTag = `registry.cloudflare.com/${ACCOUNT}/t-room-downloader-downloadercontainer:definitions-${runId}`;
    if (releaseCode) {
      console.log('Building the explicitly requested repository Container code');
      const context = resolve(directory, '../container');
      run(['build', '--platform', 'linux/amd64', '-f', join(context, 'Dockerfile'), '--build-arg', `CLAMAV_DEFINITION_REFRESH=${runId}`, '-t', temporaryTag, context]);
      console.log('Verifying small local browser fixtures and process cleanup offline');
      // Production run_phase supplies a job-local writable HOME. The direct
      // fixture runner also needs one (the image user's home is /nonexistent).
      run(['run', '--rm', '--network', 'none', '--cpus', '1', '--memory', '4g', '--entrypoint', 'python', '-e', 'PYTHONPATH=/app', '-e', 'HOME=/work', '-e', 'XDG_CONFIG_HOME=/work', '-e', 'XDG_CACHE_HOME=/work', '-e', 'MAIN_VIDEO_TEST_BROWSER=/usr/bin/chromium', temporaryTag, '-m', 'unittest', 'discover', '-s', '/app/tests', '-p', 'test_main_video.py']);
    } else {
      console.log('Building definition candidate from the deployed code base');
      run(['build', '--platform', 'linux/amd64', '-f', join(directory, 'definitions.Dockerfile'), '--build-arg', `BASE_IMAGE=${source}`, '--build-arg', `REFRESH_ID=${runId}`, '-t', temporaryTag, directory]);
    }
    console.log('Verifying candidate signatures, signed timestamps, engine and harmless fixtures');
    const raw = run(['run', '--rm', '--network', 'none', '--cpus', '1', '--memory', '4g', '--mount', `type=bind,source=${join(directory, 'verify-definitions.py')},target=/tmp/verify-definitions.py,readonly`, '--entrypoint', 'python', '-e', 'PYTHONPATH=/app', temporaryTag, '/tmp/verify-definitions.py']);
    const report = candidateReport(JSON.parse(raw), now());
    console.log('Pushing verified definition candidate');
    run(['push', temporaryTag]);
    const digests = JSON.parse(run(['image', 'inspect', temporaryTag, '--format', '{{json .RepoDigests}}']));
    const image = digests.find(validImage);
    if (!image) throw new Error('definition_digest_missing');
    const before = await api(APPLICATION_PATH);
    if (before.configuration.image !== oldImage || before.active_rollout_id) throw new Error('definition_deployment_changed');
    const lease = await readState(api);
    if (lease.run_id !== runId || Number(lease.lease_until) <= now()) throw new Error('definition_update_lease_expired');
    const jobs = await query(api, DOWNLOADER_DB, "SELECT COUNT(*) AS count FROM downloader_jobs WHERE status IN ('queued','processing','analyzing')");
    if (Number(jobs.results[0].count) > 0) {
      await query(api, SECURITY_DB, "UPDATE security_definition_updates SET last_result='deferred',lease_until=NULL WHERE service='downloader' AND run_id=?", [runId]);
      console.log('Deferred image rollout because jobs are active');
      return { deferred: true };
    }
    console.log('Starting image-only rollout; Worker code and existing grace period are unchanged');
    const rollout = await api(`${APPLICATION_PATH}/rollouts`, 'POST', {
      description: 'Daily verified ClamAV definitions', strategy: 'rolling', kind: 'full_auto',
      steps: [10, 100].map(percentage => ({ step_size: { percentage }, description: `Rollout to ${percentage}% of instances` })),
      target_configuration: definitionTarget(before.configuration, image)
    });
    await wait(api, rollout.id, image);
    const updated = await query(api, SECURITY_DB, `UPDATE security_definition_updates SET image=?,previous_image=?,source_image=?,definition_unix=?,verified_at=?,
      last_success_at=?,image_checked_at=?,deployment_matches=1,last_result='success',failure_count=0,lease_until=NULL WHERE service='downloader' AND run_id=?`,
      [image, oldImage, releaseCode ? image : source, report.definitionUnix, report.verifiedAt, now(), now(), runId]);
    if (updated.meta.changes !== 1) throw new Error('definition_completion_conflict');
    console.log('Verified definition image rollout completed');
    return { image, ...report };
  } catch (error) {
    await query(api, SECURITY_DB, "UPDATE security_definition_updates SET last_result='failed',failure_count=failure_count+1,lease_until=NULL WHERE service='downloader' AND run_id=?", [runId]);
    throw error;
  } finally {
    // Only our isolated Docker login file; do not touch the user's Docker config.
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  refresh().catch(error => { console.error(/^definition_[a-z_]+$|^cloudflare_[a-z_0-9]+$/.test(error.message) ? error.message : 'definition_update_failed'); process.exitCode = 1; });
}
