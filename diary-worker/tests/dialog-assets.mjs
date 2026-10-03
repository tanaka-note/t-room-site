import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
    return next(specifier, context);
  }
});
const worker = (await import('../src/index.js')).default;
const script = await readFile(new URL('../public/dialog-navigation.js', import.meta.url), 'utf8');
const requests = [];
const env = new Proxy({ ASSETS: { async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push(path);
  assert.equal(path, '/dialog-navigation.js');
  return new Response(script, { headers: { 'content-type': 'text/javascript' } });
} } }, { get(target, key) {
  assert.ok(key === 'ASSETS', `public script must not use ${String(key)}`);
  return target[key];
} });
for (const suffix of ['', '?v=diary-fixture', '?v=billing-fixture&app-version-check=fixture']) {
  const response = await worker.fetch(new Request(`https://fixture.test/diary/dialog-navigation.js${suffix}`), env, {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), script);
  assert.equal(response.headers.get('content-type'), 'text/javascript');
}
assert.equal(requests.length, 3);
const missing = await worker.fetch(new Request('https://fixture.test/diary/unregistered-script.js'), env, {});
assert.equal(missing.status, 404);
assert.equal(requests.length, 3, 'unknown routes must not reach the asset binding');
console.log('Diary Worker serves the shared dialog script for both build versions without authentication or DB access.');
