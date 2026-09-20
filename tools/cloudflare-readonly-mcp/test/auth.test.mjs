import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler, allowedRedirect } from '../auth.mjs';

const origin = 'https://mcp.example.test';
function fixture({ userId = 42, scope = 'read:user' } = {}) {
  const store = new Map(), calls = [], grants = [];
  const auth = { clientId: 'local-client', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256', scope: ['mcp:read'] };
  const env = { PUBLIC_ORIGIN: origin, ALLOWED_GITHUB_USER_ID: '42', GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'synthetic-only',
    OAUTH_KV: { async put(k, v, opts) { assert.equal(opts.expirationTtl, 600); store.set(k, JSON.parse(v)); }, async get(k) { return store.get(k); }, async delete(k) { store.delete(k); } },
    OAUTH_PROVIDER: { async parseAuthRequest() { return auth; }, async lookupClient() { return { clientName: '<script>fixture</script>' }; },
      async completeAuthorization(data) { grants.push(data); return { redirectTo: auth.redirectUri + '?code=synthetic' }; } }
  };
  const handler = createAuthHandler(async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.endsWith('/access_token') ? { access_token: 'synthetic-github-token', scope } : { id: userId });
  });
  const authorize = () => handler.fetch(new Request(origin + '/authorize?client_id=local-client'), env);
  async function start() {
    const consent = await authorize(), html = await consent.text();
    const key = html.match(/name="state" value="([a-f0-9]+)"/)[1];
    const response = await handler.fetch(new Request(origin + '/consent', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: consent.headers.get('set-cookie').split(';')[0] }, body: new URLSearchParams({ state: key }) }), env);
    const github = new URL(response.headers.get('location'));
    return { response, state: github.searchParams.get('state'), cookie: response.headers.get('set-cookie').split(';')[0], github };
  }
  return { store, calls, grants, auth, env, handler, authorize, start };
}

test('consent safely renders client, uses secure cookie and rejects unknown OAuth redirect/PKCE/scope', async () => {
  const f = fixture(); const r = await f.authorize(); const html = await r.text();
  assert.equal(r.status, 200); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  assert.match(r.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax; Path=\//);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  for (const patch of [{ redirectUri: 'https://evil.test/' }, { codeChallengeMethod: 'plain' }, { scope: ['write'] }]) {
    const x = fixture(); Object.assign(x.auth, patch); assert.equal((await x.authorize()).status, 400); assert.equal(x.store.size, 0);
  }
  assert.equal(allowedRedirect('https://chatgpt.com.evil.test/connector_platform_oauth_redirect'), false);
});

test('consent denies missing browser binding and cross-origin POST before GitHub', async () => {
  const f = fixture(); await f.authorize();
  for (const requestOrigin of [origin, 'https://evil.test']) {
    const r = await f.handler.fetch(new Request(origin + '/consent', { method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'state=' + 'a'.repeat(64) }), f.env);
    assert.equal(r.status, 400); assert.equal(f.calls.length, 0);
  }
});

test('owner-only GitHub callback completes PKCE flow without storing upstream credential', async () => {
  const f = fixture(); const flow = await f.start();
  assert.equal(flow.github.origin, 'https://github.com'); assert.equal(flow.github.searchParams.get('code_challenge_method'), 'S256');
  const callback = new Request(origin + '/callback?state=' + flow.state + '&code=fixture-code', { headers: { Cookie: flow.cookie } });
  const r = await f.handler.fetch(callback, f.env);
  assert.equal(r.status, 302); assert.equal(f.grants.length, 1);
  assert.deepEqual(f.grants[0].props, { userId: '42', scopes: ['mcp:read'] });
  assert.ok(!JSON.stringify(f.grants).includes('synthetic-github-token')); assert.equal(f.store.size, 0);
  assert.equal(f.calls.length, 2); assert.ok(new URLSearchParams(f.calls[0].init.body).has('code_verifier'));
  assert.equal((await f.handler.fetch(callback, f.env)).status, 400); assert.equal(f.calls.length, 2);
});

test('consent still rejects null and foreign Origin with an otherwise valid browser flow', async () => {
  for (const requestOrigin of ['null', 'https://evil.test', '']) {
    const f = fixture(); const consent = await f.authorize();
    const state = (await consent.text()).match(/name="state" value="([a-f0-9]+)"/)[1];
    const r = await f.handler.fetch(new Request(origin + '/consent', { method: 'POST',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: consent.headers.get('set-cookie').split(';')[0] },
      body: new URLSearchParams({ state }) }), f.env);
    assert.equal(r.status, 400); assert.equal(f.calls.length, 0); assert.equal(f.store.size, 1);
  }
});

for (const [label, options] of [['different user', { userId: 43 }], ['excess GitHub scope', { scope: 'repo,read:user' }]]) {
  test(`callback rejects ${label} without granting MCP access`, async () => {
    const f = fixture(options); const flow = await f.start();
    const r = await f.handler.fetch(new Request(origin + '/callback?state=' + flow.state + '&code=fixture', { headers: { Cookie: flow.cookie } }), f.env);
    assert.ok([400, 403].includes(r.status)); assert.equal(f.grants.length, 0);
  });
}

test('callback rejects missing/expired/wrong state before upstream access', async () => {
  const f = fixture(); const flow = await f.start();
  for (const cookie of ['', '__Host-MCP_FLOW=wrong']) {
    const r = await f.handler.fetch(new Request(origin + '/callback?state=' + flow.state + '&code=x', { headers: { Cookie: cookie } }), f.env);
    assert.equal(r.status, 400);
  }
  f.store.get('flow:' + flow.state).expires = 0;
  const r = await f.handler.fetch(new Request(origin + '/callback?state=' + flow.state + '&code=x', { headers: { Cookie: flow.cookie } }), f.env);
  assert.equal(r.status, 400); assert.equal(f.calls.length, 0);
});

test('unconfigured authorization fails closed', async () => {
  const f = fixture(); delete f.env.GITHUB_CLIENT_SECRET;
  assert.equal((await f.authorize()).status, 503); assert.equal(f.calls.length, 0);
});
