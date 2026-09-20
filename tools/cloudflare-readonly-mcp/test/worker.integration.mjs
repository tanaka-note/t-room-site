import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const origin = 'https://mcp.example.test';
const binding = { PUBLIC_ORIGIN: origin, ALLOWED_GITHUB_USER_ID: '42', CF_READ_ACCOUNT_ID: 'a'.repeat(32),
  CF_READ_ZONE_IDS: 'b'.repeat(32), CF_READ_DATABASE_IDS: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };

test('deployed Worker bundle enforces authentication, registration and PKCE in workerd', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'mcp', modules: true, scriptPath: new URL('../.wrangler/build/worker.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
    compatibilityDate: '2026-09-20', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'], bindings: binding, outboundService: () => { throw new Error('External requests forbidden in local test'); }, log: new Log(LogLevel.ERROR) }));
  try {
    const send = (path, init) => mf.dispatchFetch(origin + path, init);
    assert.equal((await send('/health')).status, 200);
    assert.equal((await (await send('/health')).json()).ready, false);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await send('/mcp', { method });
      assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /oauth-protected-resource/);
    }
    assert.equal((await send('/mcp', { headers: { Authorization: 'Bearer synthetic-invalid' } })).status, 401);
    const resource = await (await send('/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(resource.resource, origin + '/mcp'); assert.deepEqual(resource.scopes_supported, ['mcp:read']);
    const as = await (await send('/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']); assert.equal(as.issuer, origin);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    const register = metadata => send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) });
    assert.equal((await register({ redirect_uris: ['https://evil.test/callback'] })).status, 400);
    assert.equal((await register({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scope: 'write' })).status, 400);
    const registered = await register({ client_name: 'Local fixture', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    assert.equal(registered.status, 201);
    const client = await registered.json();
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope: 'mcp:read', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
    assert.equal((await send('/authorize?' + params)).status, 503);
    assert.equal((await send('/authorize?client_id=https://evil.test/client.json')).status, 400);
    assert.equal((await send('/oauth/token', { method: 'POST', body: 'client_id=https://evil.test/client.json' })).status, 400);
    assert.equal((await mf.dispatchFetch('https://foreign.test/health')).status, 404);
    assert.equal((await send('/consent', { method: 'POST', body: 'x'.repeat(32769) })).status, 503);
  } finally { await mf.dispose(); }
});

test('workerd full OAuth flow allows owner reads and rejects writes without upstream calls', async () => {
  let apiCalls = 0; const authCalls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'mcp', modules: true,
    scriptPath: new URL('../.wrangler/build/worker.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
    compatibilityDate: '2026-09-20', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'], log: new Log(LogLevel.ERROR),
    bindings: { ...binding, GITHUB_CLIENT_ID: 'synthetic', GITHUB_CLIENT_SECRET: 'synthetic', CF_READ_API_TOKEN: 'synthetic' },
    outboundService: async request => {
      const url = new URL(request.url);
      authCalls.push(url.origin + url.pathname);
      if (url.href === 'https://github.com/login/oauth/access_token' && request.method === 'POST') return Response.json({ access_token: 'synthetic', scope: 'read:user' });
      if (url.href === 'https://api.github.com/user' && request.method === 'GET') return Response.json({ id: 42 });
      if (url.origin !== 'https://api.cloudflare.com') throw new Error('Unexpected upstream');
      apiCalls++;
      if (url.pathname.endsWith('/graphql') && request.method === 'POST') return Response.json({ data: { viewer: {} } });
      if (url.pathname.endsWith('/query') && request.method === 'POST') return Response.json({ success: true, result: [{ results: [{ n: 1 }], meta: { rows_written: 0, changed_db: false } }] });
      assert.equal(request.method, 'GET'); return Response.json({ success: true, result: [{ id: binding.CF_READ_ACCOUNT_ID }] });
    }
  }));
  try {
    const send = (path, init = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...init });
    const registration = await send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      client_name: 'Fixture', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    const client = await registration.json(); assert.equal(registration.status, 201);
    const verifier = 'test-verifier-'.repeat(5), challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope: 'mcp:read', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp', state: 'fixture-client-state' });
    const consent = await send('/authorize?' + params); assert.equal(consent.status, 200);
    const key = (await consent.text()).match(/name="state" value="([a-f0-9]+)"/)[1];
    const github = await send('/consent', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: consent.headers.get('set-cookie').split(';')[0] }, body: new URLSearchParams({ state: key }).toString() });
    assert.equal(github.status, 302);
    const state = new URL(github.headers.get('location')).searchParams.get('state');
    const callback = await send('/callback?state=' + state + '&code=synthetic', { headers: { Cookie: github.headers.get('set-cookie').split(';')[0] } });
    assert.equal(callback.status, 302, JSON.stringify(authCalls) + await callback.text());
    const redirect = new URL(callback.headers.get('location'));
    assert.equal(redirect.searchParams.get('iss'), origin); assert.equal(redirect.searchParams.get('state'), 'fixture-client-state');
    const tokenResponse = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code: redirect.searchParams.get('code'), code_verifier: verifier, resource: origin + '/mcp' }).toString() });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json(); assert.ok(token.access_token);
    const call = async (method, params) => {
      const r = await send('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      assert.equal(r.status, 200);
      const b = await r.text(); return JSON.parse(b.startsWith('event:') ? b.split('\n').find(l => l.startsWith('data: ')).slice(6) : b);
    };
    const list = await call('tools/list', {});
    assert.equal(list.result.tools.length, 3); for (const tool of list.result.tools) assert.equal(tool.annotations.readOnlyHint, true);
    for (const [name, args] of [
      ['cloudflare_read', { path: '/accounts' }],
      ['d1_read_query', { database_id: binding.CF_READ_DATABASE_IDS, sql: 'SELECT COUNT(*) FROM diary_entries' }],
      ['cloudflare_analytics_read', { query: `{ viewer { accounts(filter: {accountTag: "${binding.CF_READ_ACCOUNT_ID}"}) { id } } }` }]
    ]) { const r = await call('tools/call', { name, arguments: args }); assert.ok(!r.error && !r.result.isError); }
    assert.equal(apiCalls, 3);
    for (const [name, args] of [
      ...['PUT', 'PATCH', 'DELETE'].map(method => ['cloudflare_read', { path: '/accounts', method }]),
      ...['DELETE FROM x', 'UPDATE x SET a=1', 'INSERT INTO x VALUES(1)'].map(sql => ['d1_read_query', { database_id: binding.CF_READ_DATABASE_IDS, sql }]),
      ['cloudflare_analytics_read', { query: 'mutation { remove }' }]
    ]) { const r = await call('tools/call', { name, arguments: args }); assert.ok(r.error || r.result.isError); assert.equal(apiCalls, 3); }
    const badAudience = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token.refresh_token, resource: 'https://foreign.test/mcp' }).toString() });
    assert.equal(badAudience.status, 400);
  } finally { await mf.dispose(); }
});
