import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, affected, changedFiles, commands, targets, installDirectories, downloader2NativeAffected } from './verify-plan.mjs';
import { dependencyInstallPlan, installArgs } from './install-verify-dependencies.mjs';
import { localConfig } from './local-dev.mjs';
import { assertPreviewSafe, prepareReleaseDependencies, releaseProfile } from './release.mjs';
import { safeEvent } from './worker-logs.mjs';
import { normalizeTextForHash } from './web-app-registry.mjs';

test('Cloud edits do not select Android, Downloader or unrelated services', () => {
  assert.deepEqual(affected(['cloud-worker/public/cloud.js']), ['cloud']);
  assert.deepEqual(affected(['cloud-worker/tests/manual-thumbnail-api.mjs']), ['cloud']);
});
test('shared authentication, PRF and SW changes include consumers', () => {
  assert.deepEqual(affected(['assets/session-secret.mjs']), ['cloud', 'security', 'diary', 'billing', 'downloader', 'downloader2', 'ai', 'auth']);
  const auth = affected(['assets/session-policy.mjs']);
  for (const t of ['cloud', 'diary', 'billing', 'auth']) assert.ok(auth.includes(t), t);
  assert.ok(affected(['security-worker/src/index.js']).includes('auth'));
  assert.ok(affected(['cloud-worker/public/crypto-vault.js']).includes('security'));
  assert.ok(affected(['diary-worker/public/service-worker.js']).includes('site'));
  assert.deepEqual(affected(['android-ai-chat/app/build.gradle.kts']), ['android-ai-chat']);
  assert.deepEqual(affected(['AGENTS.md', 'docs/development.md']), []);
});
test('Downloader 2 components select only Downloader 2 while unknown files remain site-safe', () => {
  for (const path of [
    'downloader2-worker/src/index.js',
    'downloader2-extension/service-worker.js',
    'downloader2-native/src/Tlain.Downloader2.Host/Program.cs',
    'downloader2-fixtures/server.mjs'
  ]) assert.deepEqual(affected([path]), ['downloader2'], path);
  assert.deepEqual(affected(['unknown-runtime/index.js']), ['site']);
  assert.deepEqual(affected(['docs/downloader2.md']), []);
  assert.equal(downloader2NativeAffected(['downloader2-native/src/Program.cs']), true);
  assert.equal(downloader2NativeAffected(['downloader2-extension/service-worker.js']), false);
  assert.equal(downloader2NativeAffected(['docs/downloader2.md']), false);
});
test('affected mapping is order independent and unknown runtime files are not silently skipped', () => {
  const paths = ['assets/session-policy.mjs', 'assets/pwa-auto-update.js'];
  assert.deepEqual(affected(paths), affected([...paths].reverse()));
  assert.deepEqual(affected(['new-app/index.html']), ['site']);
  assert.deepEqual(affected(['.github/workflows/verify.yml']), ['tooling']);
  assert.deepEqual(affected(['tools/install-verify-dependencies.mjs']), ['tooling']);
});
test('Downloader 2 Native CI isolates every fallible command in a fail-fast step', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8');
  const nativeJob = workflow.slice(workflow.indexOf('  downloader2-native:'), workflow.indexOf('\n  verify:', workflow.indexOf('  downloader2-native:')));
  for (const [name, command] of [
    ['Build Native solution', 'dotnet build downloader2-native/Tlain.Downloader2.slnx'],
    ['Run Native tests', 'dotnet run --project downloader2-native/tests/Tlain.Downloader2.Tests/Tlain.Downloader2.Tests.csproj'],
    ['Publish Native Host', 'dotnet publish downloader2-native/src/Tlain.Downloader2.Host/Tlain.Downloader2.Host.csproj'],
    ['Smoke test Native Messaging', 'node downloader2-native/tests/native-host-smoke.mjs'],
    ['Build isolated E2E profile', 'dotnet build downloader2-native/src/Tlain.Downloader2.Host/Tlain.Downloader2.Host.csproj']
  ]) {
    assert.match(nativeJob, new RegExp(`- name: ${name}\\r?\\n\\s+shell: pwsh\\r?\\n\\s+run: ${command.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`), name);
  }
  assert.doesNotMatch(nativeJob, /run: \|/);
});
test('content build hashes ignore checkout line endings', () => {
  const app = { id: 'fixture', publicUrls: ['/fixture/'] };
  const contract = { buildMeta: 'troom-app-build', autoUpdateMeta: 'troom-auto-update', autoUpdateValue: 'enabled' };
  const source = '<!doctype html>\n<html>\n<head></head>\n<body></body>\n</html>\n';
  assert.equal(normalizeTextForHash(source, app, contract), normalizeTextForHash(source.replaceAll('\n', '\r\n'), app, contract));
});
test('diff handles staged/unstaged/untracked files, deletion and rename without losing old owner', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 't-lain-diff-'));
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git(['init']); git(['config', 'user.email', 'fixture@example.test']); git(['config', 'user.name', 'fixture']);
    writeFileSync(resolve(dir, 'before.js'), 'one'); git(['add', '.']); git(['commit', '-m', 'fixture']);
    git(['mv', 'before.js', 'after.js']); writeFileSync(resolve(dir, 'untracked.js'), 'two');
    assert.deepEqual(changedFiles(undefined, undefined, dir).sort(), ['after.js', 'before.js', 'untracked.js']);
    assert.throws(() => changedFiles('missing-ref', 'HEAD', dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('profiles only reference existing scripts/tests and no production mutations', () => {
  for (const target of targets) for (const c of commands(target)) {
    if (c.gradle) continue;
    if (c.script) assert.ok(JSON.parse(readFileSync(resolve(root, c.cwd, 'package.json'), 'utf8')).scripts[c.script]);
    else for (const p of c.args.filter(p => /\.(?:js|mjs|cjs)$/.test(p))) assert.ok(existsSync(resolve(root, c.cwd, p)), `${target}: ${p}`);
    assert.doesNotMatch(JSON.stringify(c), /--remote|refresh-definitions|r2:lifecycle|versions.*upload/);
  }
  assert.ok(installDirectories(['auth']).includes('security-worker'));
  assert.deepEqual(installDirectories(['downloader2']), ['.', 'downloader2-worker']);
  assert.ok(commands('downloader2').some((command) => command.cwd === 'downloader2-extension' && command.script === 'check'));
  assert.ok(commands('downloader2').some((command) => command.cwd === 'downloader2-fixtures' && command.script === 'check'));
  assert(commands('site').some((command) => command.args?.join(' ') === 'tools/check-web-app-builds.mjs --target t-room-site'));
});
test('site release installs every clean-worktree dependency through the shared verify plan', () => {
  const directories = installDirectories(['site']);
  assert.deepEqual(directories, ['.', 'security-worker', 'diary-worker']);
  const securityPackage = JSON.parse(readFileSync(resolve(root, 'security-worker/package.json'), 'utf8'));
  assert.equal(securityPackage.dependencies['@simplewebauthn/server'], '13.3.2');
  assert.match(readFileSync(resolve(root, 'security-worker/src/index.js'), 'utf8'), /from ["']@simplewebauthn\/server["']/);
  const diaryPackage = JSON.parse(readFileSync(resolve(root, 'diary-worker/package.json'), 'utf8'));
  assert.equal(diaryPackage.devDependencies.playwright, '1.56.1');
  const plan = dependencyInstallPlan(['site']);
  assert.deepEqual(plan.map(step => step.directory), directories);
  for (const step of plan) assert.deepEqual(step.args, installArgs);
  const calls = [];
  const app = { deployCwd: '.' };
  assert.equal(releaseProfile(app), 'site');
  assert.equal(prepareReleaseDependencies(app, selected => calls.push(selected)), 'site');
  assert.deepEqual(calls, [['site']]);
});
test('local config strips every production resource, service, variable and trigger', () => {
  const source = JSON.parse(readFileSync(resolve(root, 'cloud-worker/wrangler.jsonc'), 'utf8'));
  const config = localConfig('cloud', { ...source, services: [{ service: 'production' }], vars: { SECRET: 'not-copyable' } });
  assert.equal(config.services, undefined); assert.equal(config.vars, undefined); assert.equal(config.queues, undefined);
  assert.equal(config.triggers, undefined); assert.equal(config.routes, undefined);
  assert.equal(config.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000');
  assert.doesNotMatch(JSON.stringify(config), /not-copyable|t-room-cloud-private|d536bdb7/);
  assert.throws(() => localConfig('downloader', {}));
});
test('Preview fails closed for backend, secret, queue or unknown configuration', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
  assertPreviewSafe(config);
  for (const key of ['d1_databases', 'services', 'queues', 'vars', 'r2_buckets', 'env']) assert.throws(() => assertPreviewSafe({ ...config, [key]: [] }));
});
test('log projection never forwards personal information or secret-bearing text', () => {
  const event = safeEvent('cloud', { outcome: 'exception', eventTimestamp: 1, scriptVersion: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    event: { request: { url: 'https://example.test/?password=secret', headers: { Cookie: 'secret' } } }, logs: [{ message: ['secret'] }], exceptions: [{ message: 'secret' }] });
  assert.doesNotMatch(JSON.stringify(event), /secret|Cookie|password|requestId/);
  assert.equal(event.result, 'exception'); assert.equal(event.operation, 'request');
});
