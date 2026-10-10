import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { createCurrentPasswordRecord } from '../../billing-worker/src/auth-security.js';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return next(specifier, context);
} });
const workers = {};
for (const service of ['cloud', 'diary', 'billing']) workers[service] = (await import(`../../${service}-worker/src/index.js`)).default;
export const fixturePassword = 'local-audit-fixture-password';
const hash = `sha256$${createHash('sha256').update(fixturePassword).digest('base64url')}`;
const billing = await createCurrentPasswordRecord(fixturePassword, 'local-fixture-pepper');

export function fixture(service) {
  const db = new DatabaseSync(':memory:');
  const dir = new URL(`../../${service}-worker/migrations/`, import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'));
  if (service === 'billing') {
    db.exec("UPDATE billing_accounts SET login_id=id||'@example.test'");
    db.prepare('UPDATE billing_accounts SET password_salt=?,password_hash=?,password_iterations=?,password_pepper_version=?').run(billing.passwordSalt, billing.passwordHash, billing.passwordIterations, billing.passwordPepperVersion);
  }
  function statement(sql, args = []) {
    return { bind: (...v) => statement(sql, v), first: async () => db.prepare(sql).get(...args) || null,
      all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => {
        const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      } };
  }
  const stored = [], queued = [], pending = [], attempted = [];
  const env = {
    DB: { prepare: statement, batch: async ss => Promise.all(ss.map(s => s.run())) },
    SESSION_SECRET: randomBytes(32).toString('hex'), AUDIT_IP_SALT: randomBytes(32).toString('hex'),
    ADMIN_LOGIN_ID: 'admin@example.test', SUBADMIN_LOGIN_ID: 'subadmin@example.test', ADMIN_PASSWORD_HASH: hash, SUBADMIN_PASSWORD_HASH: hash, ACCOUNT_KDF_ID: 'fixture-audit',
    DIARY_MAIN_ADMIN_LOGIN_ID: 'admin@example.test', DIARY_WIFE_ADMIN_LOGIN_ID: 'wife@example.test',
    DIARY_MAIN_ADMIN_PASSWORD_HASH: hash, DIARY_WIFE_ADMIN_PASSWORD_HASH: hash,
    BILLING_PASSWORD_PEPPER: 'local-fixture-pepper',
    PASSWORD_AUDIT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SECURITY: { recordAuditEvent: async e => { attempted.push(e); stored.push(e); } },
    SECURITY_AUDIT: { send: async e => queued.push(e) }
  };
  const accountId = service === 'cloud' ? 'admin' : service === 'diary' ? 'wife-admin' : 'masami';
  const loginId = service === 'billing' ? db.prepare('SELECT login_id FROM billing_accounts WHERE id=?').get(accountId).login_id : service === 'cloud' ? env.ADMIN_LOGIN_ID : env.DIARY_WIFE_ADMIN_LOGIN_ID;
  return { db, env, stored, queued, attempted, accountId, loginId, close: () => db.close(),
    async asset(path, script) {
      env.ASSETS = {fetch:async request=>{
        if(new URL(request.url).pathname!==`/${path}`) throw new Error('Unexpected asset mapping');
        return new Response(script,{headers:{'Content-Type':'text/javascript'}});
      }};
      return workers[service].fetch(new Request(`https://example.test/${service}/${path}`),env,{});
    },
    async request(path, body, headers = {}, withContext = false) {
      const r = await workers[service].fetch(new Request(`https://example.test/${service}/api/${path}`, {
        method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json', 'X-Diary-Request': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body)
      }), env, withContext ? { waitUntil: p => pending.push(p) } : {});
      await Promise.all(pending.splice(0));
      return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null), cookie: r.headers.get('set-cookie') };
    },
    disablePassword() { db.prepare("INSERT INTO password_auth_policy(service,account_id,password_auth_enabled,password_session_epoch,changed_by,reason) VALUES (?,?,0,1,'local-test','fixture')").run(service, accountId); }
  };
}

export async function securityDatabase(f, service) {
  const { default: SecurityWorker } = await import('../src/index.js');
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, dir), 'utf8'));
  db.exec("INSERT INTO security_identities(id,display_name,status) VALUES ('audit-fixture','Fixture','active')");
  db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES ('fixture-link','audit-fixture',?,?,'Fixture','active')").run(service, f.accountId);
  db.exec("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES ('fixture-credential','audit-fixture','AA','AA','active')");
  function statement(sql, args = []) { return { bind: (...v) => statement(sql, v),
    first: async () => db.prepare(sql).get(...args) || null, all: async () => ({results:db.prepare(sql).all(...args)}),
    run: async () => { const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}}; } }; }
  const worker = new SecurityWorker();
  worker.env = { DB: { prepare: statement, batch: async statements => {
    db.exec('BEGIN'); try { const result=await Promise.all(statements.map(s=>s.run())); db.exec('COMMIT');return result; }
    catch(error) { db.exec('ROLLBACK');throw error; }
  } } };
  f.env.SECURITY.recordAuditEvent = async event => { f.attempted.push(event);const result=await worker.recordAuditEvent(event);f.stored.push(event);return result; };
  return { db, worker, close: () => db.close() };
}
