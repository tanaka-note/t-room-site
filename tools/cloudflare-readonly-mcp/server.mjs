import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PolicyError, validateConfig, validateGet, validateGraphql, validateSql } from './policy.mjs';

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const scalar = z.union([z.string(), z.number(), z.boolean()]);
export const definitions = {
  cloudflare_read: {
    description: 'Read Cloudflare configuration through an explicit GET endpoint allowlist for the configured account. Returns metadata; credential values are redacted.',
    inputSchema: z.strictObject({ path: z.string(), query: z.record(z.string(), scalar).optional() }), annotations
  },
  d1_read_query: {
    description: 'Read D1 with one validated SQLite SELECT, WITH SELECT, EXPLAIN SELECT, or PRAGMA table_info statement. Only configured database IDs are accessible. Returns at most 200 rows.',
    inputSchema: z.strictObject({ database_id: z.string(), sql: z.string(), params: z.array(z.union([z.string(), z.number(), z.null()])).optional() }), annotations
  },
  cloudflare_analytics_read: {
    description: 'Read Cloudflare GraphQL Analytics with one query scoped to the configured account or zones.',
    inputSchema: z.strictObject({ query: z.string(), variables: z.record(z.string(), z.unknown()).optional() }), annotations
  }
};

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  if (['secret_text', 'plain_text', 'secret_key'].includes(value.type)) return { name: value.name, type: value.type, value: '[REDACTED]' };
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /password|secret|credential|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key/i.test(key) ? '[REDACTED]' : redact(child)]));
}

export function createReader({ config, apiToken, fetchImpl = fetch }) {
  validateConfig(config);
  if (typeof apiToken !== 'string' || !apiToken.trim()) throw new PolicyError('A dedicated read-only API token is required.');
  // Copy the security boundary so callers cannot mutate it after construction.
  config = { accountId: config.accountId, zoneIds: [...config.zoneIds], databaseIds: [...config.databaseIds] };
  async function request(method, path, query, body) {
    const url = new URL('https://api.cloudflare.com/client/v4' + path);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new PolicyError('Cloudflare request failed; no upstream details were logged.'); }
    if (!response.ok) throw new PolicyError(`Cloudflare returned HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1048576) { await reader.cancel(); throw new PolicyError('Response too large; narrow the query.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let data;
    try {
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new PolicyError('Unexpected Cloudflare response format.'); }
    if (data.success === false || data.errors?.length || data.result?.some?.(r => r.success === false)) {
      throw new PolicyError('Cloudflare rejected the read request.');
    }
    return data;
  }
  return async function call(name, input) {
    if (!Object.hasOwn(definitions, name)) throw new PolicyError('Unknown read-only tool.');
    const parsed = definitions[name].inputSchema.safeParse(input);
    if (!parsed.success) throw new PolicyError('Invalid read-only tool arguments.');
    const args = parsed.data;
    if (name === 'cloudflare_read') {
      validateGet(args.path, args.query, config);
      const data = await request('GET', args.path, args.query);
      const result = args.path === '/accounts' ? data.result.filter(a => a.id === config.accountId) : data.result;
      return redact({ result, result_info: data.result_info });
    }
    if (name === 'd1_read_query') {
      if (!config.databaseIds.includes(args.database_id)) throw new PolicyError('Database is outside the configured read scope.');
      validateSql(args.sql, args.params);
      const data = await request('POST', `/accounts/${config.accountId}/d1/database/${args.database_id}/query`, null,
        { sql: args.sql, params: args.params || [] });
      if (data.result.some(r => r.meta?.changed_db === true || Number(r.meta?.rows_written || 0) > 0)) {
        throw new PolicyError('Unexpected D1 mutation metadata. Stop use and review the read-only token policy.');
      }
      return { result: data.result.map(r => ({ results: r.results.slice(0, 200), truncated: r.results.length > 200,
        rows_read: r.meta?.rows_read, rows_written: r.meta?.rows_written, changed_db: r.meta?.changed_db })) };
    }
    validateGraphql(args.query, args.variables, config);
    const data = await request('POST', '/graphql', null, { query: args.query, variables: args.variables || {} });
    return { data: data.data };
  };
}

// The embedding HTTP host MUST authenticate and authorize the caller before constructing this server.
// This factory exposes no network listener and cannot publish a public, unauthenticated endpoint.
export function createServer(options) {
  const read = createReader(options);
  const server = new McpServer({ name: 'tlain-cloudflare-readonly', version: '0.1.0' });
  for (const [name, definition] of Object.entries(definitions)) {
    server.registerTool(name, definition, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await read(name, args)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof PolicyError ? error.message : 'Read request failed.' }] }; }
    });
  }
  return server;
}
