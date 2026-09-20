import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from './server.mjs';
import { allowedClientId, allowedRedirect, createAuthHandler, readBody } from './auth.mjs';

export const apiHandler = { async fetch(request, env, ctx) {
  if (ctx.props?.userId !== env.ALLOWED_GITHUB_USER_ID || !ctx.props?.scopes?.includes('mcp:read')) return new Response('Forbidden', { status: 403 });
  if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
  if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  if (!env.CF_READ_API_TOKEN) return new Response('Service unavailable', { status: 503 });
  return createMcpHandler(() => createServer({
    config: { accountId: env.CF_READ_ACCOUNT_ID, zoneIds: env.CF_READ_ZONE_IDS.split(',').filter(Boolean), databaseIds: env.CF_READ_DATABASE_IDS.split(',').filter(Boolean) },
    apiToken: env.CF_READ_API_TOKEN
  })).fetch(request);
} };

export function makeProvider(origin) {
  return new OAuthProvider({
    apiRoute: '/mcp', apiHandler, defaultHandler: createAuthHandler(),
    authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['mcp:read'], allowPlainPKCE: false, allowImplicitFlow: false, allowTokenExchangeGrant: false,
    accessTokenTTL: 3600, refreshTokenTTL: 2592000, clientRegistrationTTL: 7776000,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['mcp:read'], resource_name: 'T-lain Cloudflare Read-Only' },
    clientRegistrationCallback({ clientMetadata: m }) {
      if (!Array.isArray(m.redirect_uris) || !m.redirect_uris.length || m.redirect_uris.some(u => !allowedRedirect(u)) || m.software_statement ||
        (m.scope && String(m.scope).split(' ').some(s => !['mcp:read', 'offline_access'].includes(s)))) {
        return { code: 'invalid_client_metadata', description: 'Only the configured ChatGPT read-only client is supported.' };
      }
    },
    onError({ status, code, headers }) { return Response.json({ error: code, error_description: 'OAuth request rejected.' }, { status, headers }); }
  });
}

export default { async fetch(request, env, ctx) {
  try {
    const url = new URL(request.url);
    if (!env.PUBLIC_ORIGIN?.startsWith('https://') || url.origin !== env.PUBLIC_ORIGIN) return new Response('Not found', { status: 404 });
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ service: 'tlain-cloudflare-readonly',
      version: env.VERSION_METADATA?.id || 'local', ready: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.CF_READ_API_TOKEN) }, { headers: { 'Cache-Control': 'no-store' } });
    if (url.search.length > 16000) return new Response('Request too large', { status: 413 });
    if (url.pathname === '/authorize' && !allowedClientId(url.searchParams.get('client_id'))) return new Response('Invalid client', { status: 400 });
    if (request.method === 'POST') {
      const body = await readBody(request, url.pathname === '/mcp' ? 65536 : 32768);
      if (url.pathname === '/oauth/token') {
        const params = new URLSearchParams(body);
        if (params.has('client_id') && !allowedClientId(params.get('client_id'))) return new Response('Invalid client', { status: 400 });
      }
      request = new Request(request, { body });
    }
    return await makeProvider(env.PUBLIC_ORIGIN).fetch(request, env, ctx);
  } catch { return new Response('Service unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
} };
