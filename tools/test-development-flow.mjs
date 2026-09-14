import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, affected, changedFiles, commands, targets, installDirectories } from './verify-plan.mjs';
import { localConfig } from './local-dev.mjs';
import { assertPreviewSafe } from './release.mjs';
import { safeEvent } from './worker-logs.mjs';

test('Cloud edits do not select Android, Downloader or unrelated services', () => {
  assert.deepEqual(affected(['cloud-worker/public/cloud.js']), ['cloud']);
  assert.deepEqual(affected(['cloud-worker/tests/manual-thumbnail-api.mjs']), ['cloud']);
});
test('shared authentication, PRF and SW changes include consumers', () => {
  const auth = affected(['assets/session-policy.mjs']);
  for (const t of ['cloud', 'diary', 'billing', 'auth']) assert.ok(auth.includes(t), t);
  assert.ok(affected(['security-worker/src/index.js']).includes('auth'));
  assert.ok(affected(['cloud-worker/public/crypto-vault.js']).includes('security'));
  assert.ok(affected(['diary-worker/public/service-worker.js']).includes('site'));
  assert.deepEqual(affected(['android-ai-chat/app/build.gradle.kts']), ['android-ai-chat']);
  assert.deepEqual(affected(['AGENTS.md', 'docs/development.md']), []);
});
test('affected mapping is order independent and unknown runtime files are not silently skipped', () => {
  const paths = ['assets/session-policy.mjs', 'assets/pwa-auto-update.js'];
  assert.deepEqual(affected(paths), affected([...paths].reverse()));
  assert.deepEqual(affected(['new-app/index.html']), ['site']);
  assert.deepEqual(affected(['.github/workflows/verify.yml']), ['tooling']);
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
