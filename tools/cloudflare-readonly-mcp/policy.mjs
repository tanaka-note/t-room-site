import sqlite from 'node-sql-parser/build/sqlite.js';
import { parse, visit, valueFromASTUntyped } from 'graphql';

const parser = new sqlite.Parser();
export class PolicyError extends Error {
  constructor(message = 'Request is not permitted by the read-only policy.') { super(message); }
}
const fail = () => { throw new PolicyError(); };
const sqlFunctions = new Set(`abs avg count sum total min max round coalesce ifnull nullif iif
  lower upper length octet_length substr substring instr replace trim ltrim rtrim concat concat_ws
  date time datetime julianday unixepoch strftime timediff hex unhex quote typeof unicode char
  group_concat string_agg json jsonb json_array json_object json_extract jsonb_extract json_type
  json_valid json_array_length json_quote json_group_array json_group_object json_each json_tree
  json_set json_insert json_replace json_remove json_patch
  row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
  sqlite_version likelihood likely unlikely`.split(/\s+/).filter(Boolean));
const sqlTypes = new Set(`select column_ref binary_expr unary_expr aggr_func function window_func
  number string single_quote_string double_quote_string bool null origin expr_list case when
  cast dataType default extract interval star ASC DESC`.split(/\s+/).filter(Boolean));

export function validateSql(sql, params = []) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 16000 || /\0/.test(sql)) fail();
  if (!Array.isArray(params) || params.length > 100 || params.some(x => x !== null &&
    !(typeof x === 'string' && x.length <= 16000) && !(typeof x === 'number' && Number.isFinite(x)))) fail();
  // A deliberately small PRAGMA grammar; assignments and arbitrary PRAGMAs never reach D1.
  if (/^\s*PRAGMA\s+table_info\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*"|'[A-Za-z_][A-Za-z0-9_]*')\s*\)\s*;?\s*$/i.test(sql)) {
    if (params.length) fail();
    return sql;
  }
  const select = sql.replace(/^\s*EXPLAIN\s+(?:QUERY\s+PLAN\s+)?/i, '');
  let ast;
  try { ast = parser.astify(select); } catch { throw new PolicyError('Unsupported SQL syntax; nothing was sent to D1.'); }
  if (Array.isArray(ast)) { if (ast.length !== 1) fail(); ast = ast[0]; }
  if (ast?.type !== 'select') fail();
  let nodes = 0;
  function check(node) {
    if (!node || typeof node !== 'object') return;
    if (++nodes > 4000) fail();
    if (node.type && !sqlTypes.has(node.type)) fail();
    if (node.into || node.for_update || node.locking_read) fail();
    if (node.type === 'origin' && node.value !== '?') fail();
    if (['function', 'aggr_func', 'window_func'].includes(node.type)) {
      const name = typeof node.name === 'string' ? node.name :
        node.name?.name?.length === 1 ? node.name.name[0].value : '';
      if (!sqlFunctions.has(String(name).toLowerCase())) fail();
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(check); else check(child);
    }
  }
  check(ast);
  return sql; // Never rewrite literals, placeholders, identifiers, or the statement sent upstream.
}

export function validateGraphql(query, variables = {}, { accountId, zoneIds }) {
  if (typeof query !== 'string' || query.length > 16000 || !variables || Array.isArray(variables) || typeof variables !== 'object') fail();
  if (JSON.stringify(variables).length > 16000) fail();
  let ast;
  try { ast = parse(query, { maxTokens: 3000 }); } catch { throw new PolicyError('Unsupported GraphQL syntax.'); }
  const operations = ast.definitions.filter(d => d.kind === 'OperationDefinition');
  if (operations.length !== 1 || operations[0].operation !== 'query' ||
    ast.definitions.some(d => !['OperationDefinition', 'FragmentDefinition'].includes(d.kind))) fail();
  const roots = operations[0].selectionSet.selections;
  if (roots.some(s => s.kind !== 'Field' || s.name.value !== 'viewer')) fail();
  // Every account/zone collection, including those in fragments, must explicitly bind its scope.
  let scoped = 0;
  visit(ast, { Field(node) {
    if (!['accounts', 'zones'].includes(node.name.value)) return;
    const filter = node.arguments?.find(a => a.name.value === 'filter');
    const value = filter && valueFromASTUntyped(filter.value, variables);
    const key = node.name.value === 'accounts' ? 'accountTag' : 'zoneTag';
    if (!value || Object.keys(value).length !== 1 || typeof value[key] !== 'string') fail();
    if (key === 'accountTag' ? value[key] !== accountId : !zoneIds.includes(value[key])) fail();
    scoped++;
  }});
  if (!scoped) fail();
  return query;
}

const id = '[A-Za-z0-9_-]+';
export const accountPaths = [
  'd1/database', 'd1/database/{id}',
  'workers/scripts', 'workers/scripts/{id}/settings', 'workers/scripts/{id}/deployments',
  'workers/scripts/{id}/versions', 'workers/scripts/{id}/versions/{id}',
  'r2/buckets', 'r2/buckets/{id}',
  'queues', 'queues/{id}', 'queues/{id}/consumers',
  'containers/applications', 'containers/applications/{id}',
  'pages/projects', 'pages/projects/{id}', 'pages/projects/{id}/deployments',
  'pages/projects/{id}/deployments/{id}',
  'storage/kv/namespaces', 'storage/kv/namespaces/{id}/keys'
];
const queryKeys = new Set(['page', 'per_page', 'cursor', 'limit', 'name', 'name.contains', 'prefix',
  'direction', 'order', 'since', 'until', 'environment', 'start', 'end']);

export function validateGet(path, query = {}, config) {
  if (typeof path !== 'string' || path.length > 1024 || /[?%#\\\s]/.test(path) || path.includes('..')) fail();
  if (!query || Array.isArray(query) || typeof query !== 'object') fail();
  for (const [key, value] of Object.entries(query)) {
    if (!queryKeys.has(key) || !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 512) fail();
  }
  const base = `/accounts/${config.accountId}/`;
  const accountMatch = path.startsWith(base) && accountPaths.some(p =>
    new RegExp('^' + p.replaceAll('{id}', id) + '$').test(path.slice(base.length)));
  const zoneMatch = config.zoneIds.some(zone => path === `/zones/${zone}/workers/routes`);
  if (path !== '/accounts' && !accountMatch && !zoneMatch) fail();
  return path;
}

export function validateConfig(config) {
  if (!config || !/^[a-f0-9]{32}$/.test(config.accountId) || !Array.isArray(config.zoneIds) ||
    config.zoneIds.some(id => !/^[a-f0-9]{32}$/.test(id)) || !Array.isArray(config.databaseIds) ||
    !config.databaseIds.length || config.databaseIds.some(id => !/^[a-f0-9-]{36}$/.test(id))) fail();
}
