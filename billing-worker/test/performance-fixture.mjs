import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return next(specifier, context);
} });
export const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length);
export function sourceAtBaseline(path) {
  return execFileSync('git', ['show', `${baseline}:${path}`], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
}
const workerUrl = new URL('../src/index.js', import.meta.url);
let workerSource = (baseline ? sourceAtBaseline('billing-worker/src/index.js') : readFileSync(workerUrl,'utf8'))
  .replace(/from "(\.[^"]+)"/g, (_, path) => `from "${new URL(path, workerUrl).href}"`)
  .replace('recordSecurityAudit,', 'recordSecurityAudit as untimedAudit,');
// In-memory local profiler only. Preserve function bodies and never instrument
// the checked-in runtime or expose arguments/results to the metrics output.
for (const [name, envIndex] of [['readSession',1],['createSessionToken',2],['refreshAuthenticatedSession',2]]) {
  workerSource = workerSource.replace(`async function ${name}(`, `async function untimed_${name}(`);
  workerSource += `\nasync function ${name}(...args) { const start=performance.now(); try { return await untimed_${name}(...args); }
    finally { args[${envIndex}].__fixtureTimings?.${name}.push(performance.now()-start); } }`;
}
workerSource += `\nasync function recordSecurityAudit(...args) { const start=performance.now(); try { return await untimedAudit(...args); }
  finally { args[0].__fixtureTimings?.audit.push(performance.now()-start); } }`;
export const worker = (await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`)).default;
const Security = (await import('../../security-worker/src/index.js')).default;
export const origin = 'https://example.test';

function database(service, metrics) {
  const db = new DatabaseSync(':memory:');
  const dir = new URL(`../../${service}-worker/migrations/`, import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  const execute = (sql, args, method) => {
    const start = performance.now();
    const row = { sql, ms: 0 };
    metrics.sql.push(row);
    try { return db.prepare(sql)[method](...args); }
    finally { row.ms = performance.now() - start; }
  };
  function prepare(sql, args = []) {
    return { sql, bind: (...values) => prepare(sql, values),
      first: async () => execute(sql, args, 'get') || null,
      all: async () => ({ results: execute(sql, args, 'all') }),
      run: async () => { const r = execute(sql, args, 'run'); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      batchRead: () => ({ results: execute(sql, args, 'all') }) };
  }
  return { db, binding: { prepare, batch: async statements => {
    metrics.batches++;
    db.exec('BEGIN');
    try { const results = statements.map(s => s.batchRead()); db.exec('COMMIT'); return results; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } } };
}

export function fixture() {
  const metrics = { billing: { sql: [], batches: 0 }, security: { sql: [], batches: 0 }, rpc: [], audits: [],
    timings:{readSession:[],createSessionToken:[],refreshAuthenticatedSession:[],audit:[]} };
  const local = database('billing', metrics.billing), remote = database('security', metrics.security);
  remote.db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('fixture-identity','Fixture','active',1);
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('Y3JlZGVudGlhbA','fixture-identity','AQI','AQI','active');`);
  for (const account of local.db.prepare('SELECT id FROM billing_accounts').all()) {
    remote.db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES(?,'fixture-identity','billing',?,'Fixture','active')").run(`link-${account.id}`, account.id);
  }
  const pending = [];
  const security = new Security();
  security.env = { DB: remote.binding, SESSION_SECRET: randomBytes(32).toString('hex'), PASSKEY_ENABLED: 'true' };
  security.ctx = { waitUntil: p => pending.push(p) };
  const env = { DB: local.binding, SESSION_SECRET: randomBytes(32).toString('hex'), PASSKEY_ENABLED: 'true', SESSION_VERSION: '3', __fixtureTimings:metrics.timings };
  const handoffs = new Map();
  const f = { env, security, metrics, db: local.db, securityDb: remote.db, beforeTouch: null, afterRead: null,
    reset() { for (const m of [metrics.billing, metrics.security]) { m.sql.length = 0; m.batches = 0; } metrics.rpc.length = 0; metrics.audits.length = 0; for(const values of Object.values(metrics.timings))values.length=0; },
    async request(path, cookie, { method = 'GET', body, active = true } = {}) {
      const start = performance.now();
      const response = await worker.fetch(new Request(`${origin}/billing/api/${path}`, { method,
        headers: { Origin: origin, 'Content-Type': 'application/json', ...(active ? { 'X-Troom-Activity': 'foreground' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { waitUntil: p => pending.push(p) });
      const ms = performance.now() - start;
      await Promise.all(pending.splice(0));
      return { status: response.status, body: await response.json(), headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';', 1)[0], ms };
    },
    async login(account = 'owner') {
      const token = crypto.randomUUID();
      handoffs.set(token, { identityId: 'fixture-identity', credentialId: 'Y3JlZGVudGlhbA', serviceLinkId: `link-${account}`, serviceAccountId: account, sessionEpoch: 1 });
      return f.request('passkey/handoff', null, { method: 'POST', body: { handoffToken: token } });
    },
    sign(payload) { const data = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `troom_billing_session=${data}.${createHmac('sha256', env.SESSION_SECRET).update(data).digest('base64url')}`; },
    close() { local.db.close(); remote.db.close(); }
  };
  env.SECURITY = {
    async passkeyRollingSession(input) {
      const entry = { action: input.action, ms: 0 };
      metrics.rpc.push(entry);
      if (input.action === 'touch') await f.beforeTouch?.();
      const start = performance.now();
      try {
        const result = await security.passkeyRollingSession(input);
        if (input.action === 'read') await f.afterRead?.();
        return result;
      } finally { entry.ms = performance.now() - start; }
    },
    validatePasskeySession: input => security.validatePasskeySession(input),
    // Preserve the synchronous service audit boundary; avoid unrelated audit D1
    // writes when counting authentication queries. No event contents are logged.
    recordAuditEvent: async event => { metrics.audits.push(event.eventType); },
    redeemHandoff: async token => { const value = handoffs.get(token); handoffs.delete(token); return value; }
  };
  env.SECURITY_AUDIT = { send: async event => { metrics.audits.push(event.eventType); } };
  return f;
}

export function payload(cookie) { return JSON.parse(Buffer.from(cookie.split('=', 2)[1].split('.')[0], 'base64url')); }

export function seedLedger(f) {
  const entries = f.db.prepare("INSERT INTO billing_entries(account_id,document_type,entry_date,category,amount_yen,description,created_by) VALUES(?,?,?,?,?,'Fixture','owner')");
  const settlements = f.db.prepare("INSERT INTO billing_settlements(account_id,settlement_date,direction,method,amount_yen,created_by) VALUES(?,?,?,'cash',?,'owner')");
  for (const account of ['chiharu','hideaki','masami','yuuka','machiko']) {
    for (const date of ['2026-08-01','2026-09-01','2026-09-30','2026-10-01','2026-10-24','2026-11-01']) {
      for (const type of ['invoice','payment_notice']) {
        entries.run(account,type,date,'purchase',1000); entries.run(account,type,date,'offset',-7);
      }
      for (const direction of ['incoming','outgoing']) settlements.run(account,date,direction,11);
    }
  }
}
