import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer, createReader } from '../server.mjs';
import { validateSql, validateGraphql, PolicyError, accountPaths } from '../policy.mjs';

const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), databaseId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const config = { accountId, zoneIds: [zoneId], databaseIds: [databaseId] };
const token = 'synthetic-token-never-log-this';
function fixture(data = { success: true, result: [] }, options = {}) {
  const calls = [];
  const read = createReader({ config, apiToken: token, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return Response.json(data, options);
  }});
  return { read, calls };
}

const allowedSql = [
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
  'SELECT * FROM diary_entries WHERE content LIKE ? LIMIT 5',
  "SELECT entry_date, substr(content, max(1, instr(content, ?) - 30), 100) AS excerpt FROM diary_entries WHERE deleted_at IS NULL AND status = 'published' AND instr(content, ?) > 0 ORDER BY entry_date DESC LIMIT 5;",
  'WITH recent AS (SELECT * FROM diary_entries LIMIT 5) SELECT count(*) FROM recent',
  'SELECT a.id FROM diary_entries a JOIN diary_photos b ON a.id = b.entry_id WHERE a.id IN (SELECT id FROM diary_entries)',
  'SELECT count(*), min(id), max(id) FROM diary_entries GROUP BY entry_date HAVING count(*) > 1',
  'SELECT 1 UNION ALL SELECT 2',
  "SELECT 'DELETE; DROP TABLE t;' AS content",
  'SELECT ? AS content',
  'SELECT COUNT(*) FROM diary_entries',
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'diary_entries'",
  "SELECT '/* text */ -- text; it''s data' AS content",
  "SELECT json_extract(content, '$.name') FROM diary_entries",
  "SELECT date(entry_date), coalesce(title, '') FROM diary_entries"
];
for (const [index, sql] of allowedSql.entries()) test(`read SQL ${index + 1}`, () => assert.equal(validateSql(sql), sql));

const deniedSql = [
  'DELETE FROM diary_entries', 'UPDATE diary_entries SET content = 1',
  "INSERT INTO diary_entries(content) VALUES ('x')", 'DROP TABLE diary_entries',
  'CREATE TABLE x (id)', 'ALTER TABLE diary_entries ADD x TEXT', 'REPLACE INTO x VALUES (1)',
  'VACUUM', "ATTACH DATABASE 'x' AS x", 'DETACH DATABASE x', 'PRAGMA writable_schema = 1',
  'TRUNCATE TABLE diary_entries', 'PRAGMA table_info(diary_entries)',
  'EXPLAIN SELECT * FROM diary_entries', 'EXPLAIN QUERY PLAN SELECT * FROM diary_entries',
  '/* harmless comment */ SELECT 1', 'SELECT 1 -- end',
  'WITH x AS (SELECT 1) /* hidden */ SELECT * FROM x',
  'SELECT 1; --\nDELETE FROM diary_entries', 'SELECT 1;;',
  "SELECT 'x\\'; DELETE FROM diary_entries; --'", "SELECT 'unterminated",
  'PRAGMA journal_mode=WAL', 'PRAGMA table_info=1', 'PRAGMA optimize',
  'SELECT 1; DELETE FROM diary_entries', 'SELECT 1; /* hiding */ UPDATE x SET y=1',
  'SELECT 1; SELECT 2', 'WITH x AS (SELECT 1) DELETE FROM diary_entries',
  'WITH x AS (DELETE FROM diary_entries RETURNING *) SELECT * FROM x',
  'EXPLAIN DELETE FROM diary_entries', 'EXPLAIN QUERY PLAN UPDATE x SET y=1',
  "SELECT load_extension('x')", "SELECT writefile('x','y')", "SELECT eval('DELETE FROM x')",
  "SELECT readfile('x')", "SELECT 'load_extension'(1)", 'SELECT "load_extension"(1)',
  'SELECT * FROM pragma_writable_schema(1)', 'SELECT * INTO OUTFILE x FROM diary_entries',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SELECT 1\0; DELETE FROM x', '', 'not SQL',
  'PRAGMA table_info(x); DELETE FROM x', 'SELECT sqlite_rename_table(1)',
  'WITH x AS (SELECT load_extension(1)) SELECT * FROM x', 'SELECT 1 FOR UPDATE'
];
for (const [index, sql] of deniedSql.entries()) test(`write/unsafe SQL ${index + 1} never reaches fetch`, async () => {
  const { read, calls } = fixture();
  await assert.rejects(read('d1_read_query', { database_id: databaseId, sql }), PolicyError);
  assert.equal(calls.length, 0);
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${method} cannot be supplied to GET tool`, async () => {
  const { read, calls } = fixture();
  await assert.rejects(read('cloudflare_read', { path: '/accounts', method }), PolicyError);
  assert.equal(calls.length, 0);
});
for (const path of ['/user/tokens', '/accounts/evil/d1/database', `/accounts/${accountId}/queues/q/messages/pull`,
  'https://evil.test/', '/accounts?x=y', '/accounts/../user', '/accounts%2f..', '/accounts\\evil',
  `/accounts/${accountId}/workers/scripts/test/secrets`, `/accounts/${accountId}/d1/database/${databaseId}/query`]) {
  test(`denied path ${path}`, async () => {
    const { read, calls } = fixture(); await assert.rejects(read('cloudflare_read', { path }), PolicyError); assert.equal(calls.length, 0);
  });
}
test('all catalog GET paths are accepted and never carry a request body', async () => {
  const { read, calls } = fixture();
  for (const path of accountPaths) await read('cloudflare_read', { path: `/accounts/${accountId}/` + path.replaceAll('{id}', 'resource-1') });
  await read('cloudflare_read', { path: `/zones/${zoneId}/workers/routes` });
  assert.equal(calls.length, accountPaths.length + 1);
  for (const { url, init } of calls) { assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(url.origin, 'https://api.cloudflare.com'); assert.equal(init.redirect, 'manual'); }
});
test('D1 preserves SQL/params and uses only the configured query endpoint', async () => {
  const { read, calls } = fixture({ success: true, result: [{ results: [{ content: 'ピザ' }], meta: { rows_written: 0, changed_db: false } }] });
  const sql = 'SELECT ? AS content'; const params = ["ピザ'; DELETE FROM diary_entries;--"];
  const out = await read('d1_read_query', { database_id: databaseId, sql, params });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url.pathname, `/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { sql, params }); assert.equal(out.result[0].rows_written, 0);
});
test('foreign database and arbitrary request fields rejected before fetch', async () => {
  const { read, calls } = fixture();
  await assert.rejects(read('d1_read_query', { database_id: 'other', sql: 'SELECT 1' }), PolicyError);
  await assert.rejects(read('cloudflare_read', { path: '/accounts', headers: { Authorization: 'x' } }), PolicyError);
  await assert.rejects(read('cloudflare_read', { path: '/accounts', query: { redirect: 'https://evil.test' } }), PolicyError);
  await assert.rejects(read('execute', { code: 'fetch()' }), PolicyError); assert.equal(calls.length, 0);
});

const analytics = `query($id: String!) { viewer { accounts(filter: {accountTag: $id}) { id } } }`;
test('GraphQL query permits scoped analytics variables and fragments', async () => {
  validateGraphql(analytics, { id: accountId }, config);
  validateGraphql(`query { viewer { ...A } } fragment A on Viewer { zones(filter:{zoneTag:"${zoneId}"}) { id } }`, {}, config);
  const { read, calls } = fixture({ data: { viewer: {} } });
  await read('cloudflare_analytics_read', { query: analytics, variables: { id: accountId } });
  assert.equal(calls[0].url.pathname, '/client/v4/graphql'); assert.equal(calls[0].init.method, 'POST');
});
for (const query of [
  'mutation { remove }', 'subscription { changed }', `${analytics} mutation { remove }`,
  '{ viewer { accounts { id } } }', '{ viewer { accounts(filter: {accountTag: "foreign"}) { id } } }',
  '{ viewer { zones(filter: {zoneTag: "foreign"}) { id } } }', 'query A { a } query B { b }',
  '{ viewer { accounts(filter: {accountTag: "x", OR: []}) { id } } }'
]) test(`GraphQL rejection ${query.slice(0, 45)}`, async () => {
  const { read, calls } = fixture();
  await assert.rejects(read('cloudflare_analytics_read', { query }), PolicyError); assert.equal(calls.length, 0);
});
test('metadata redacts binding values and token-like fields', async () => {
  const { read } = fixture({ success: true, result: { bindings: [{ type: 'plain_text', name: 'EXAMPLE', text: token }], password: token } });
  const result = await read('cloudflare_read', { path: `/accounts/${accountId}/workers/scripts/test/settings` });
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(JSON.stringify(result).includes('EXAMPLE'));
});
test('upstream errors never return credentials, SQL or raw response', async () => {
  const { read } = fixture({ errors: [{ message: token }] }, { status: 403 });
  await assert.rejects(read('cloudflare_read', { path: '/accounts' }), error => error.message === 'Cloudflare returned HTTP 403.');
});
test('config is copied and oversized requests are rejected', async () => {
  const mutable = structuredClone(config); let calls = 0;
  const read = createReader({ config: mutable, apiToken: token, fetchImpl: () => { calls++; } });
  mutable.databaseIds.push('other');
  await assert.rejects(read('d1_read_query', { database_id: 'other', sql: 'SELECT 1' }), PolicyError);
  await assert.rejects(read('d1_read_query', { database_id: databaseId, sql: 'SELECT ' + 'x'.repeat(17000) }), PolicyError);
  assert.equal(calls, 0);
});
test('real MCP tools/list exposes exactly three strict read-only tools', async () => {
  const handler = createMcpHandler(() => createServer({ config, apiToken: token, fetchImpl: () => { throw Error('No upstream call expected'); } }));
  const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }));
  const body = await response.text();
  const data = JSON.parse(body.startsWith('event:') ? body.split('\n').find(l => l.startsWith('data: ')).slice(6) : body);
  assert.equal(response.status, 200); assert.equal(data.result.tools.length, 3);
  for (const tool of data.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.annotations, undefined);
    assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.inputSchema.properties.method, undefined);
    assert.equal(tool.inputSchema.properties.code, undefined);
  }
  assert.deepEqual(data.result.tools.map(t => t.name).sort(), ['cloudflare_analytics_read', 'cloudflare_read', 'd1_read_query']);
});
test('real MCP tools/call rejects writes before any upstream request', async () => {
  let calls = 0;
  const handler = createMcpHandler(() => createServer({ config, apiToken: token,
    fetchImpl: async () => { calls++; return Response.json({ success: true, result: [{ results: [{ value: 1 }], meta: { rows_written: 0 } }] }); } }));
  async function call(name, args) {
    const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) }));
    const body = await response.text();
    return JSON.parse(body.startsWith('event:') ? body.split('\n').find(l => l.startsWith('data: ')).slice(6) : body);
  }
  for (const sql of deniedSql) {
    const data = await call('d1_read_query', { database_id: databaseId, sql });
    assert.equal(data.result.isError, true); assert.equal(calls, 0);
    assert.ok(!JSON.stringify(data).includes(token));
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const data = await call('cloudflare_read', { path: '/accounts', method });
    assert.ok(data.error || data.result?.isError); assert.equal(calls, 0);
  }
  for (const query of ['mutation { remove }', 'subscription { changed }']) {
    const data = await call('cloudflare_analytics_read', { query });
    assert.equal(data.result.isError, true); assert.equal(calls, 0);
  }
  const good = await call('d1_read_query', { database_id: databaseId, sql: 'SELECT 1 AS value' });
  assert.ok(!good.result.isError); assert.equal(calls, 1);
});

test('accepted SQL executes against local SQLite without changing schema or data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE diary_entries (id, entry_date, title, content, deleted_at, status);
      CREATE TABLE diary_photos (entry_id);
      INSERT INTO diary_entries VALUES (1, '2026-01-01', 'fixture', '{"name":"ピザ"}', NULL, 'published');`);
    const snapshot = () => JSON.stringify([
      db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
      db.prepare('SELECT * FROM diary_entries').all(),
      db.prepare('SELECT * FROM diary_photos').all(),
      db.prepare('SELECT total_changes() AS n').get()
    ]);
    const before = snapshot();
    for (const sql of allowedSql) {
      validateSql(sql);
      db.prepare(sql).all(...Array((sql.match(/\?/g) || []).length).fill('ピザ'));
      assert.equal(snapshot(), before);
    }
  } finally { db.close(); }
});

test('real MCP successful GET, D1 count/schema and GraphQL dispatch retain read-only boundaries', async () => {
  const calls = [];
  const handler = createMcpHandler(() => createServer({ config, apiToken: token, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.pathname.endsWith('/graphql')) return Response.json({ data: { viewer: {} } });
    if (url.pathname.endsWith('/query')) return Response.json({ success: true, result: [{ results: [{ count: 1 }], meta: { rows_written: 0, changed_db: false } }] });
    return Response.json({ success: true, result: [{ id: accountId }] });
  } }));
  const inputs = [
    ['cloudflare_read', { path: '/accounts' }],
    ['cloudflare_read', { path: `/accounts/${accountId}/d1/database` }],
    ['d1_read_query', { database_id: databaseId, sql: 'SELECT COUNT(*) FROM diary_entries' }],
    ['d1_read_query', { database_id: databaseId, sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table'" }],
    ['cloudflare_analytics_read', { query: analytics, variables: { id: accountId } }]
  ];
  for (const [name, args] of inputs) {
    const response = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }) }));
    const body = await response.text();
    const data = JSON.parse(body.startsWith('event:') ? body.split('\n').find(l => l.startsWith('data: ')).slice(6) : body);
    assert.equal(response.status, 200); assert.ok(!data.error && !data.result.isError);
  }
  assert.deepEqual(calls.map(c => [c.init.method, c.url.pathname]), [
    ['GET', '/client/v4/accounts'], ['GET', `/client/v4/accounts/${accountId}/d1/database`],
    ['POST', `/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`],
    ['POST', `/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`], ['POST', '/client/v4/graphql']
  ]);
});
test('SQL/GraphQL validation does not log credentials or private literals', async () => {
  const messages = [], saved = {};
  for (const method of ['log', 'warn', 'error']) { saved[method] = console[method]; console[method] = (...args) => messages.push(args); }
  try {
    const { read } = fixture();
    await assert.rejects(read('d1_read_query', { database_id: databaseId, sql: `DELETE FROM x WHERE y='${token}'` }));
  } finally { for (const method of Object.keys(saved)) console[method] = saved[method]; }
  assert.deepEqual(messages, []);
});
test('D1 truncation is explicit and unexpected write metadata fails closed', async () => {
  const { read } = fixture({ success: true, result: [{ results: Array.from({ length: 201 }, (_, id) => ({ id })), meta: { rows_written: 0 } }] });
  const out = await read('d1_read_query', { database_id: databaseId, sql: 'SELECT id FROM x' });
  assert.equal(out.result[0].results.length, 200); assert.equal(out.result[0].truncated, true);
  const bad = fixture({ success: true, result: [{ results: [], meta: { rows_written: 1 } }] });
  await assert.rejects(bad.read('d1_read_query', { database_id: databaseId, sql: 'SELECT 1' }), PolicyError);
  assert.equal(bad.calls.length, 1); // Never retry an unexpected response.
});
test('upstream response size is bounded', async () => {
  const { read } = fixture({ success: true, result: 'x'.repeat(1048577) });
  await assert.rejects(read('cloudflare_read', { path: '/accounts' }), /Response too large/);
});

test('upstream redirects fail closed without a follow-up request', async () => {
  const { read, calls } = fixture({}, { status: 302, headers: { Location: 'https://foreign.test/' } });
  await assert.rejects(read('cloudflare_read', { path: '/accounts' }), /HTTP 302/);
  assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, 'manual');
});
