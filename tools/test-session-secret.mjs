import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { isValidSessionSecret, requireSessionSecret } from '../assets/session-secret.mjs';

const weakValues = [undefined, null, 123, {}, '', ' '.repeat(40), randomBytes(24).toString('base64url').slice(0, 31),
  'password', 'changeme', 'password'.repeat(8), 'changeme'.repeat(8),
  'replace-with-a-long-random-secret-for-production', 'your-secret'.repeat(4), 'test-secret'.repeat(4),
  'GENERATE_A_RANDOM_32_BYTE_OR_LONGER_SECRET', 'generate-a-random-local-only-value',
  'a'.repeat(64), '0123456789abcdef'.repeat(4), '\ud800' + randomBytes(32).toString('hex'),
  '\n' + randomBytes(32).toString('hex'), randomBytes(32).toString('hex') + ' '];

test('rejects missing, short, malformed and known weak values without logging', t => {
  const logs = [];
  for (const name of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, name, (...args) => logs.push(args));
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  for (const value of weakValues) {
    assert.equal(isValidSessionSecret(value), false);
    assert.throws(() => requireSessionSecret(value, HttpError), error => error.status === 503 && error.message === 'セッションの認証設定が完了していません。');
  }
  assert.deepEqual(logs, []);
});
test('every SESSION_SECRET example is rejected', () => {
  for (const service of ['security', 'cloud', 'billing', 'ai']) {
    const text = readFileSync(new URL('../' + service + '-worker/.dev.vars.example', import.meta.url), 'utf8');
    const value = /^SESSION_SECRET=(.*)$/m.exec(text)?.[1].trim();
    assert.equal(isValidSessionSecret(value), false, service);
  }
});
test('uses UTF-8 byte length, accepts random keys and does not transform them', () => {
  const key = randomBytes(32).toString('hex');
  assert.equal(isValidSessionSecret(key), true);
  assert.equal(isValidSessionSecret(randomBytes(24).toString('base64url')), true); // exactly 32 UTF-8 bytes
  // Distinct multibyte characters exercise the boundary, not a production key example.
  const prefix = 'あいうえおかきくけこ';
  assert.equal(Buffer.byteLength(prefix + 'a'), 31);
  assert.equal(isValidSessionSecret(prefix + 'a'), false);
  assert.equal(isValidSessionSecret(prefix + 'ab'), true);
  requireSessionSecret(key, Error);
  assert.equal(key.length, 64);
});

// Import complete Worker sources; only runtime host classes are replaced. Expose
// private signing helpers in this test process, without changing production APIs.
const exportsByService = {
  security: ['signedCookie', 'readSecuritySession'], cloud: ['createSessionToken', 'createShareSessionToken', 'readSession', 'readShareSession'],
  diary: ['createSessionToken', 'readSession'], billing: ['createSessionToken', 'readSession'],
  downloader: ['signSession', 'verifySession'], ai: ['signSession', 'verifySession']
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {} export const waitUntil = () => {};', shortCircuit: true };
    if (specifier === '@cloudflare/containers') return { url: 'data:text/javascript,export class Container {} export class ContainerProxy {} export const getContainer = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const service = /\/([^/]+)-worker\/src\/index\.js$/.exec(url)?.[1];
    if (exportsByService[service]) return { format: 'module', source: readFileSync(new URL(url), 'utf8') + `\nexport { ${exportsByService[service].join(',')} };`, shortCircuit: true };
    return next(url, context);
  }
});
for (const service of Object.keys(exportsByService)) {
  const module = await import(`../${service}-worker/src/index.js`);
  test(`${service}: invalid configuration stops API before bindings, never issues cookies or leaks values`, async t => {
    const logs = [];
    for (const name of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, name, (...args) => logs.push(args));
    for (const value of weakValues) {
      const env = new Proxy({ SESSION_SECRET: value }, { get(target, key) { if (key in target) return target[key]; throw new Error('binding accessed before validation'); } });
      for (const [method, path] of [['GET', 'session'], ['POST', 'login'], ['POST', 'passkey/handoff']]) {
        const request = new Request(`https://example.test/${service}/api/${path}`, { method });
        const worker = typeof module.default === 'function' ? Object.assign(new module.default(), { env, ctx: {} }) : module.default;
        const response = await worker.fetch(request, env, {});
        assert.equal(response.status, 503, service);
        assert.equal(response.headers.has('Set-Cookie'), false);
        const body = await response.text();
        if (typeof value === 'string' && value.length > 3 && value.trim()) assert.equal(body.includes(value), false);
      }
    }
    assert.equal(JSON.stringify(logs).includes('SESSION_SECRET'), false);
    for (const value of weakValues.filter(v => typeof v === 'string' && v.trim().length > 3)) assert.equal(JSON.stringify(logs).includes(value), false);
  });
  test(`${service}: signing helpers also fail closed when called directly`, async () => {
    const env = { SESSION_SECRET: 'test-secret' };
    const calls = service === 'security' ? [() => module.signedCookie(env, 'cookie', {}, 3600, true)]
      : service === 'cloud' ? [() => module.createSessionToken({}, 3600, env), () => module.createShareSessionToken({}, 'id', 3600, env)]
      : service === 'diary' ? [() => module.createSessionToken({}, {}, env)]
      : service === 'billing' ? [() => module.createSessionToken({}, 3600, env)] : [() => module.signSession({}, env)];
    for (const call of calls) await assert.rejects(call, error => error.status === 503);
  });
  test(`${service}: session readers reject signatures made with a weak key`, async () => {
    const env = { SESSION_SECRET: 'test-secret' };
    const encoded = Buffer.from(JSON.stringify({ authMethod: 'passkey', exp: 9999999999, expiresAt: 9999999999 })).toString('base64url');
    const token = `${encoded}.${createHmac('sha256', env.SESSION_SECRET).update(encoded).digest('base64url')}`;
    const request = new Request('https://example.test/', { headers: { Cookie: `troom_${service}_session=${token}` } });
    if (service === 'security') assert.equal(await module.readSecuritySession(request, env, 'troom_security_session', 'admin'), null);
    else if (module.readSession) assert.equal(await module.readSession(request, env), null);
    else assert.equal(await module.verifySession(token, env), null);
  });
  if (service === 'security') test('Security cookie signature, expiry and passkey epoch remain enforced', async () => {
    let epoch = 1;
    const env = { SESSION_SECRET: randomBytes(32).toString('hex'), PASSKEY_ENABLED: 'true', DB: { prepare: () => ({ run: async () => {}, first: async () => ({ passkey_session_epoch: epoch, switch_observed_enabled: 1 }) }) } };
    const payload = { kind: 'admin', identityId: 'fixture', authMethod: 'passkey', passkeySessionEpoch: 1 };
    const cookie = await module.signedCookie(env, 'session', payload, 60, true);
    assert.match(cookie, /Path=\/security; HttpOnly; SameSite=Strict; Secure$/);
    assert.doesNotMatch(cookie, /Max-Age|Expires=/);
    const read = value => module.readSecuritySession(new Request('https://example.test/', { headers: { Cookie: value.split(';')[0] } }), env, 'session', 'admin');
    assert.equal((await read(cookie)).identityId, 'fixture');
    const token = cookie.split(';')[0].slice('session='.length);
    const [encoded, signature] = token.split('.');
    assert.equal(signature, createHmac('sha256', env.SESSION_SECRET).update(encoded).digest('base64url'));
    assert.equal(await read(`session=${encoded}.${randomBytes(32).toString('base64url')}`), null);
    assert.equal(await read(await module.signedCookie(env, 'session', payload, -1, true)), null);
    epoch = 2;
    assert.equal(await read(cookie), null);
  });
  if (service === 'cloud') test('Cloud shared-link sessions preserve signatures, expiry and SESSION_VERSION', async () => {
    const env = { SESSION_SECRET: randomBytes(32).toString('hex'), SESSION_VERSION: '5' };
    const share = { id: 1, token_hash: 'fixture-share' };
    const read = token => module.readShareSession(new Request('https://example.test/', { headers: { Cookie: `troom_cloud_share_session=${token}` } }), env, share);
    const token = await module.createShareSessionToken(share, 'session', 60, env);
    assert.equal((await read(token)).shareId, 1);
    const [encoded, signature] = token.split('.');
    assert.equal(signature, createHmac('sha256', env.SESSION_SECRET).update(encoded).digest('base64url'));
    await assert.rejects(read(`${encoded}.${randomBytes(32).toString('base64url')}`), error => error.status === 401);
    await assert.rejects(read(await module.createShareSessionToken(share, 'session', -1, env)), error => error.status === 401);
    env.SESSION_VERSION = '6';
    await assert.rejects(read(token), error => error.status === 401);
    env.SESSION_SECRET = 'test-secret';
    await assert.rejects(read(token), error => error.status === 401);
  });
  if (['ai', 'downloader'].includes(service)) test(`${service}: real HMAC roundtrip, forgery, expiry, version and weak-key rejection`, async () => {
    const env = { SESSION_SECRET: randomBytes(32).toString('hex'), SESSION_VERSION: '3' };
    const payload = { authMethod: 'passkey', identityId: 'fixture', serviceAccountId: 'owner', expiresAt: Math.floor(Date.now() / 1000) + 60, sessionVersion: '3' };
    const token = await module.signSession(payload, env);
    const [encoded, signature] = token.split('.');
    assert.equal(signature, createHmac('sha256', env.SESSION_SECRET).update(encoded).digest('base64url'));
    assert.deepEqual(await module.verifySession(token, env), payload);
    assert.equal(await module.verifySession(token, { ...env, SESSION_VERSION: '4' }), null);
    assert.equal(await module.verifySession(token, { ...env, SESSION_SECRET: 'test-secret' }), null);
    assert.equal(await module.verifySession(`${encoded}.${randomBytes(32).toString('base64url')}`, env), null);
    assert.equal(await module.verifySession(await module.signSession({ ...payload, expiresAt: 1 }, env), env), null);
  });
}
