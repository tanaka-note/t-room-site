import test from 'node:test';
import assert from 'node:assert/strict';
import { SecurityWorker } from './health-security-fixture.mjs';

test('old Health setup and API URLs are gone before assets or authentication', async () => {
  const worker = new SecurityWorker();
  worker.env = { ASSETS: { fetch: () => new Response('Security Center') } };
  for (const [path, method] of [
    ['/security/health.html', 'GET'], ['/security/health', 'HEAD'],
    ['/security/%68ealth.html', 'GET'], ['/security/health-crypto.mjs', 'GET'],
    ['/security/health-redirect.js', 'GET'], ['/security/health-setup.mjs', 'GET'],
    ['/security/api/health/own', 'GET'], ['/security/api/health/grant', 'POST'],
  ]) {
    const response = await worker.fetch(new Request(`https://tanaka-note.com${path}`, { method }));
    assert.equal(response.status, 410, path);
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
  assert.equal(await (await worker.fetch(new Request('https://tanaka-note.com/security/'))).text(), 'Security Center');
});
