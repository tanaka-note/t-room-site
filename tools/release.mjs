import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './verify-plan.mjs';
import { installVerifyDependencies } from './install-verify-dependencies.mjs';
import { loadWebAppRegistry, expectedBuild } from './web-app-registry.mjs';

export function assertPreviewSafe(config) {
  const allowed = new Set(['name', 'compatibility_date', 'assets', 'main', '$schema']);
  if (config.name !== 't-room-site' || config.main !== 'site-worker/index.mjs' || Object.keys(config).some(k => !allowed.has(k))) {
    throw new Error('Preview upload is limited to the public, binding-free site. Backend services use local fixtures until isolated staging bindings exist.');
  }
}
export function releaseProfile(app) {
  return app.deployCwd === '.' ? 'site' : app.deployCwd.replace(/-worker$/, '');
}
export function prepareReleaseDependencies(app, install = installVerifyDependencies) {
  const profile = releaseProfile(app);
  install([profile]);
  return profile;
}
export function runProductionDelivery(app, { runCommand, rootDirectory = root, deployDirectory = resolve(root, app.deployCwd) }) {
  runCommand(rootDirectory, ['tools/check-web-app-builds.mjs', '--target', app.deployTarget]);
  runCommand(deployDirectory, [resolve(deployDirectory, 'node_modules/wrangler/bin/wrangler.js'), 'deploy']);
  runCommand(rootDirectory, ['tools/verify-web-app-builds.mjs', '--target', app.deployTarget]);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(root, 'tools/release.mjs')) {
  const [mode, target = 'site'] = process.argv.slice(2);
  if (!['preview', 'production'].includes(mode)) throw new Error('Usage: release.mjs preview site | production <registry app id>');
  const registry = await loadWebAppRegistry();
  const app = registry.apps.find(a => a.id === target);
  if (!app) throw new Error('Unknown web-apps.json app id');
  const git = args => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const head = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain'])) throw new Error('Release requires a clean checkout with committed build markers.');
  function run(cwd, args) {
    const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`Release command failed (${r.status})`);
  }
  const cwd = resolve(root, app.deployCwd);
  if (mode === 'preview') {
    if (target !== 'site') throw new Error('Backend Preview is disabled: existing bindings point to production. Use local:dev and verify --browser.');
    const config = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
    assertPreviewSafe(config);
    prepareReleaseDependencies(app);
    run(root, ['tools/verify.mjs', '--target', 'site']);
    run(root, ['tools/prepare-static-assets.mjs']);
    const dir = resolve(root, 'tmp/preview'); mkdirSync(dir, { recursive: true });
    const path = resolve(dir, 'wrangler.json');
    writeFileSync(path, JSON.stringify({ ...config, main: resolve(root, config.main), assets: { ...config.assets, directory: resolve(root, config.assets.directory) }, preview_urls: true }, null, 2));
    run(root, ['node_modules/wrangler/bin/wrangler.js', 'versions', 'upload', '--config', path, '--preview-alias', `commit-${head.slice(0, 12)}`, '--message', `Preview ${head}`]);
  } else {
    if (app.deployTarget === 't-room-downloader') throw new Error('Downloader requires its existing verified Container/ClamAV rollout procedure.');
    git(['fetch', 'origin', 'main']);
    if (head !== git(['rev-parse', 'origin/main'])) throw new Error('Production requires HEAD exactly matching latest origin/main.');
    const profile = prepareReleaseDependencies(app);
    run(root, ['tools/verify.mjs', '--target', profile, '--browser', '--build']);
    const expected = await expectedBuild(app, registry.contract);
    if (app.buildMode === 'content-hash' && !readFileSync(resolve(root, app.entrypoints[0]), 'utf8').includes(expected)) throw new Error('Build markers are stale; sync the affected app and commit before release.');
    if (git(['status', '--porcelain'])) throw new Error('Verification changed tracked files; inspect before release.');
    if (head !== git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0]) throw new Error('main advanced during verification; rebase and verify again.');
    runProductionDelivery(app, { runCommand: run, deployDirectory: cwd });
  }
}
