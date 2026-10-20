import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
const require = createRequire(realpathSync(new URL('../node_modules/wrangler/package.json', import.meta.url)));
const { build } = require('esbuild');
export async function bundle(path, extra = '') {
  const source = readFileSync(path, 'utf8');
  const result = await build({ stdin: { contents: source + extra, sourcefile: fileURLToPath(path), resolveDir: fileURLToPath(new URL('.', path)) }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'fixture-boundaries', setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|@simplewebauthn\/server)$/ }, a => ({ path: a.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: a.path === 'cloudflare:workers' ? 'export class WorkerEntrypoint { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' : 'export const generateAuthenticationOptions=async()=>({}),generateRegistrationOptions=async()=>({}),verifyAuthenticationResponse=async()=>({}),verifyRegistrationResponse=async()=>({});' }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
export function d1(sqlite) {
  return { prepare(sql) { let values = []; return { bind(...v) { values = v; return this; }, async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; }, runSync() { return { meta: sqlite.prepare(sql).run(...values) }; }, async run() { return this.runSync(); } }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { const results = statements.map(s => s.runSync()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }
  };
}
export const payments = await bundle(new URL('../src/index.js', import.meta.url), '\nexport {signSession};');
export function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO payments_accounts(id,display_name) VALUES(?,?)').run('owner', 'Sample Owner');
  const sessions = new Map(); let active = true, consumed = false;
  const env = { DB: d1(sqlite), SESSION_SECRET: randomBytes(32).toString('hex'), PASSKEY_ENABLED: 'true', SESSION_VERSION: '1',
    SECURITY: { async redeemHandoff(token, service) { if (token !== 'fixture-handoff' || consumed || service !== 'payments') return null; consumed = true; return { identityId: 'primary-admin', serviceAccountId: 'owner', credentialId: 'fixture-credential', serviceLinkId: 'fixture-link', sessionEpoch: 1 }; },
      async passkeyRollingSession(input) { if (!active || input.service !== 'payments' || input.identityId !== 'primary-admin' || input.serviceAccountId !== 'owner') return { valid: false };
        if (input.action === 'register') sessions.set(input.sessionIdHash, { valid: true, expiresAt: input.expiresAt });
        if (input.action === 'end') { sessions.delete(input.sessionIdHash); return { valid: true }; }
        const state = sessions.get(input.sessionIdHash); if (state && input.action === 'touch') state.expiresAt = Math.floor(Date.now() / 1000) + 43200; return state || { valid: false }; },
      async recordAuditEvent() { return { stored: true }; }
    }, ASSETS: { async fetch() { return new Response('fixture shell'); } } };
  const worker = new payments.default({}, env);
  let cookie = '';
  async function request(path, body, headers = {}, method) { return worker.fetch(new Request(`https://example.test/payments${path}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { Origin: 'https://example.test', 'Content-Type': 'application/json', Cookie: cookie, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })); }
  async function login() { const response = await request('/api/passkey/handoff', { handoffToken: 'fixture-handoff' }); if (response.status !== 200) throw new Error(`fixture login ${response.status}`); cookie = response.headers.get('Set-Cookie').split(';')[0]; return response; }
  return { sqlite, env, worker, request, login, renewHandoff() { consumed = false; }, get cookie() { return cookie; }, set cookie(v) { cookie = v; }, setActive(v) { active = v; }, close() { sqlite.close(); } };
}
