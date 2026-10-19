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
const requests = [];
for (const name of ['dialog-navigation', 'diary-photo-viewer']) {
  const script = await readFile(new URL(`../public/${name}.js`, import.meta.url), 'utf8');
  const env = new Proxy({ ASSETS: { async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    assert.equal(path, `/${name}.js`);
    return new Response(script, { headers: { 'content-type': 'text/javascript' } });
  } } }, { get(target, key) {
    assert.ok(key === 'ASSETS', `public script must not use ${String(key)}`);
    return target[key];
  } });
  for (const suffix of ['', '?v=diary-fixture', '?v=billing-fixture&app-version-check=fixture']) {
    const response = await worker.fetch(new Request(`https://fixture.test/diary/${name}.js${suffix}`), env, {});
    assert.equal(response.status, 200);
    assert.equal(await response.text(), script);
    assert.equal(response.headers.get('content-type'), 'text/javascript');
  }
  const missing = await worker.fetch(new Request('https://fixture.test/diary/unregistered-script.js'), env, {});
  assert.equal(missing.status, 404);
}
assert.equal(requests.length, 6, 'unknown routes must not reach the asset binding');
console.log('Diary Worker serves the dialog and photo viewer modules for versioned requests without authentication or DB access.');
