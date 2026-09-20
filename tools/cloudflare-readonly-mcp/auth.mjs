const cookieName = '__Host-MCP_FLOW';
const ttl = 600;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
const cookie = (value, age = ttl) => `${cookieName}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
const denied = (status = 400) => new Response('Authorization unavailable or denied.', { status, headers: { 'Cache-Control': 'no-store' } });

export function allowedRedirect(uri) {
  return uri === 'https://chatgpt.com/connector_platform_oauth_redirect' ||
    /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri);
}

export function allowedClientId(id) {
  return typeof id === 'string' && (id === 'https://chatgpt.com/oauth/client.json' ||
    /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]+\/client\.json$/.test(id) ||
    /^[A-Za-z0-9_-]{1,200}$/.test(id));
}

export async function readBody(request, limit = 32768) {
  if (!request.body) return '';
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function getFlow(request, env, stage, key) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) return null;
  const binding = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (binding !== await digest(key)) return null;
  const item = await env.OAUTH_KV.get(`flow:${key}`, 'json');
  return item?.stage === stage && item.expires > Date.now() ? item : null;
}

async function putFlow(env, key, data) {
  await env.OAUTH_KV.put(`flow:${key}`, JSON.stringify({ ...data, expires: Date.now() + ttl * 1000 }), { expirationTtl: ttl });
}

export function createAuthHandler(fetchImpl = fetch) {
  return { async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !/^\d+$/.test(env.ALLOWED_GITHUB_USER_ID || '')) return denied(503);
      if (url.pathname === '/authorize' && request.method === 'GET') {
        if (!allowedClientId(url.searchParams.get('client_id'))) return denied();
        const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        if (!allowedRedirect(auth.redirectUri) || auth.codeChallengeMethod !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(auth.codeChallenge || '') ||
          auth.scope.some(s => !['mcp:read', 'offline_access'].includes(s))) return denied();
        const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
        if (!client) return denied();
        const key = nonce(); await putFlow(env, key, { stage: 'consent', auth });
        return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T-lain Cloudflare Read-Only</title><body><h1>読み取り専用接続の確認</h1><p>接続元: ${escapeHtml(client.clientName || 'ChatGPT')}</p><p>Cloudflare構成、許可されたD1データ、Analyticsを読み取ります。Cloudflareリソースの変更は許可しません。</p><p>GitHubの許可済み本人アカウントでログインしてください。</p><form method="post" action="/consent"><input type="hidden" name="state" value="${key}"><button type="submit">読み取り接続を承認してGitHubへ進む</button></form></body></html>`, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; form-action 'self' https://github.com/login/oauth/authorize; frame-ancestors 'none'; base-uri 'none'",
            // Preserve Origin on the same-origin form POST; never send a referrer cross-origin.
            'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Set-Cookie': cookie(await digest(key)) }
        });
      }
      if (url.pathname === '/consent' && request.method === 'POST') {
        if (request.headers.get('origin') !== env.PUBLIC_ORIGIN || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return denied();
        const key = new URLSearchParams(await readBody(request)).get('state');
        const flow = await getFlow(request, env, 'consent', key); if (!flow) return denied();
        await env.OAUTH_KV.delete(`flow:${key}`);
        const state = nonce(); const verifier = nonce();
        await putFlow(env, state, { stage: 'github', auth: flow.auth, verifier });
        const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const github = new URL('https://github.com/login/oauth/authorize');
        for (const [k, v] of Object.entries({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: env.PUBLIC_ORIGIN + '/callback', scope: 'read:user', state, code_challenge: challenge, code_challenge_method: 'S256' })) github.searchParams.set(k, v);
        return new Response(null, { status: 302, headers: { Location: github.href, 'Set-Cookie': cookie(await digest(state)), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        const state = url.searchParams.get('state');
        const flow = await getFlow(request, env, 'github', state);
        const code = url.searchParams.get('code'); if (!flow || !code || code.length > 1024 || url.searchParams.has('error')) return denied();
        await env.OAUTH_KV.delete(`flow:${state}`);
        const exchange = await fetchImpl('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code,
            redirect_uri: env.PUBLIC_ORIGIN + '/callback', code_verifier: flow.verifier }).toString() });
        if (!exchange.ok) return denied();
        const token = JSON.parse(await readBody(exchange));
        if (typeof token.access_token !== 'string' || token.error ||
          String(token.scope || '').split(/[ ,]+/).some(s => s && s !== 'read:user')) return denied();
        const profileResponse = await fetchImpl('https://api.github.com/user', { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'T-lain-ReadOnly-MCP' } });
        if (!profileResponse.ok) return denied();
        const profile = JSON.parse(await readBody(profileResponse));
        if (String(profile.id) !== env.ALLOWED_GITHUB_USER_ID) return denied(403);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: flow.auth, userId: String(profile.id),
          metadata: { service: 'tlain-cloudflare-readonly' }, scope: ['mcp:read'], props: { userId: String(profile.id), scopes: ['mcp:read'] } });
        return new Response(null, { status: 302, headers: { Location: redirectTo, 'Set-Cookie': cookie('', 0), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      return denied(404);
    } catch { return denied(); } // Never return or log provider errors, codes, tokens, or private data.
  } };
}
