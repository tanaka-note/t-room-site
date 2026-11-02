import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';

test('legacy Health setup paths stay inside Security Center before automatic HTML redirects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'security-health-redirect-'));
  const script = join(directory, 'proxy.mjs'), config = join(directory, 'wrangler.json');
  writeFileSync(script, `export default { fetch(request, env) {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/^\\/security(?=\\/|$)/, '') || '/';
    return env.ASSETS.fetch(new Request(url, request));
  } };`);
  writeFileSync(config, JSON.stringify({ name: 'security-health-redirect-fixture', compatibility_date: '2026-08-20',
    assets: { directory: fileURLToPath(new URL('../public', import.meta.url)), binding: 'ASSETS', run_worker_first: true } }));
  let worker;
  try {
    worker = await unstable_dev(script, { config, local: true, port: 0, logLevel: 'error', persist: false,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false } });
    for (const path of ['/security/health.html', '/security/health', '/security/health.html?from=legacy']) {
      const response = await worker.fetch(path, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const target = new URL(response.headers.get('location'), 'https://fixture.test');
      assert.equal(target.pathname, '/security/');
      assert.equal(target.hash, '#health-setup');
    }
    const response = await worker.fetch('/security/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /セキュリティセンター/);
  } finally {
    await worker?.stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^security-health-redirect-/);
    rmSync(directory, { recursive: true, force: true });
  }
});
