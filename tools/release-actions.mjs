import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, affected } from './verify-plan.mjs';
import { loadWebAppRegistry } from './web-app-registry.mjs';
import { healthProductionPreflight } from './health-production-preflight.mjs';

// Containers retain their signed, leased rollout workflow. No D1/R2 CRUD is needed here.
export const productionTargets = ['site', 'cloud', 'security', 'diary', 'billing', 'downloader2', 'ai', 'inventory', 'health', 'payments'];
export const workerName = target => {
  if (![...productionTargets, 'downloader'].includes(target)) throw new Error('Unknown production target');
  return `t-room-${target}`;
};
export function productionPlan(selected, { event, ref, requested = 'none', enabled = false }) {
  if (ref !== 'refs/heads/main' || !enabled) return [];
  if (event === 'workflow_dispatch') {
    if (requested === 'none') return [];
    workerName(requested);
    return [requested];
  }
  return event === 'push' ? [...productionTargets, 'downloader'].filter(t => selected.includes(t)) : [];
}
export function manualVerification(target) {
  workerName(target);
  return target === 'site' ? ['site'] : affected([`${target}-worker/src/index.js`]);
}
export function assertActionsRelease(env, head) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'tanaka-note/t-room-site'
      || env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
      || env.TROOM_CI_RESULT !== 'success' || !/^[a-f0-9]{40}$/.test(head)
      || env.GITHUB_SHA !== head || env.TROOM_VERIFIED_SHA !== head) {
    throw new Error('Production requires successful CI for this exact main commit in this repository.');
  }
}
export function uploadedVersion(output, name, type = 'version-upload') {
  const uploads = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(x => x.type === type);
  if (uploads.length !== 1 || uploads[0].worker_name !== name || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uploads[0].version_id || '')) {
    throw new Error('Wrangler did not report exactly one version for the selected Worker.');
  }
  return uploads[0].version_id;
}
export function assertDeployedVersion(deployments, version) {
  const active = deployments?.deployments?.[0]?.versions;
  if (!Array.isArray(active) || active.length !== 1 || active[0].version_id !== version || active[0].percentage !== 100) {
    throw new Error('Production is not serving the uploaded version at 100%.');
  }
}
export function assertVersionSettings(before, after) {
  for (const key of ['routes', 'route', 'workers_dev', 'preview_urls', 'triggers', 'tail_consumers', 'migrations', 'containers']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error(`Non-versioned infrastructure change (${key}) requires the dedicated release procedure.`);
  }
  if (JSON.stringify(before.queues?.consumers) !== JSON.stringify(after.queues?.consumers)) throw new Error('Queue consumer changes require the dedicated release procedure.');
}
export function assertDenied(status, body) {
  if (![401, 403].includes(status) || body?.success !== false) {
    const codes = (body?.errors || []).map(error => error.code).filter(Number.isFinite);
    throw new Error(`Token scope denial not established (HTTP ${status}; codes ${codes.join(',') || 'none'}).`);
  }
}
async function api(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30000)
  });
  // Never print API response bodies, headers, or credentials on failures.
  if (!response.ok) throw new Error(`Cloudflare verification failed (HTTP ${response.status}).`);
  const body = await response.json();
  if (!body.success) throw new Error('Cloudflare verification failed.');
  return body.result;
}
export async function checkTokenScope() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-f0-9]{32}$/.test(account || '') || !process.env.CLOUDFLARE_API_TOKEN) throw new Error('Production credentials are missing.');
  for (const target of [...productionTargets, 'downloader']) {
    await api(`/accounts/${account}/workers/scripts/${workerName(target)}/settings`);
    console.log(`[permissions] ${workerName(target)}: readable`);
  }
  // These known resources exist; only read-only requests are used to prove denial.
  for (const path of [`/accounts/${account}/workers/scripts/sakura-mail-cloud/settings`, `/accounts/${account}/d1/database`, `/accounts/${account}/r2/buckets`]) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30000)
    });
    const body = await response.json().catch(() => null);
    assertDenied(response.status, body);
    console.log(`[permissions] unrelated resource: denied (${response.status})`);
  }
}
export async function releaseActions(target) {
  const downloaderWorkerOnly = target === 'downloader' && process.env.TROOM_DOWNLOADER_WORKER_ONLY === 'true';
  if (!productionTargets.includes(target) && !downloaderWorkerOnly) throw new Error('Downloader Container releases must use ClamAV daily definitions with release_code=true.');
  const git = args => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const head = git(['rev-parse', 'HEAD']);
  assertActionsRelease(process.env, head);
  if (git(['status', '--porcelain'])) throw new Error('Production requires a clean checkout.');
  if (git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0] !== head) throw new Error('main advanced; release the latest verified commit.');
  const registry = await loadWebAppRegistry();
  const app = registry.apps.find(a => a.id === target);
  const directory = resolve(root, target === 'site' ? '.' : `${target}-worker`);
  const name = workerName(target);
  const config = JSON.parse(readFileSync(resolve(directory, 'wrangler.jsonc'), 'utf8'));
  if (config.name !== name || (config.containers?.length && !downloaderWorkerOnly)) throw new Error('Worker configuration does not match the allowed production target.');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const baseline = process.env.GITHUB_EVENT_NAME === 'push' ? event.before : `${head}^`;
  if (!baseline || /^0+$/.test(baseline)) throw new Error('Initial infrastructure must be provisioned before automatic code releases.');
  const configPath = target === 'site' ? 'wrangler.jsonc' : `${target}-worker/wrangler.jsonc`;
  const previousConfig = JSON.parse(git(['show', `${baseline}:${configPath}`]));
  assertVersionSettings(previousConfig, config);
  const run = (cwd, args, env = process.env) => {
    const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Production command failed.');
  };
  if (app) run(root, ['tools/check-web-app-builds.mjs', '--target', app.deployTarget]);
  if (target === 'health') healthProductionPreflight(directory);
  await api(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${name}/settings`);
  const outDir = resolve(root, 'tmp/production', target); mkdirSync(outDir, { recursive: true });
  const output = resolve(outDir, `upload-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.ndjson`);
  if (existsSync(output)) throw new Error('Refusing to reuse a previous upload result.');
  const cli = resolve(directory, 'node_modules/wrangler/bin/wrangler.js');
  // Version commands leave routes, domains, schedules and Container rollouts untouched.
  const uploadArgs = downloaderWorkerOnly ? ['deploy', '--containers-rollout=none'] : ['versions', 'upload', '--message', `GitHub ${head}`, '--tag', head.slice(0, 12)];
  run(directory, [cli, ...uploadArgs], { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output });
  const version = uploadedVersion(readFileSync(output, 'utf8'), name, downloaderWorkerOnly ? 'deploy' : 'version-upload');
  if (!downloaderWorkerOnly) {
    if (git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0] !== head) throw new Error('main advanced during upload; version was not promoted.');
    run(directory, [cli, 'versions', 'deploy', `${version}@100%`, '--yes']);
  }
  const deployments = await api(`/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${name}/deployments`);
  assertDeployedVersion(deployments, version);
  if (app) run(root, ['tools/verify-web-app-builds.mjs', '--target', app.deployTarget]);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Production verified\nWorker: ${name}\nCommit: ${head}\nVersion: ${version} (100%)\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--check-token') await checkTokenScope();
  else await releaseActions(process.argv[2]);
}
