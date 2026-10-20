import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { bundle, d1, fixture, payments } from './fixture.js';
const directory = new URL('../../security-worker/migrations/', import.meta.url);
const migrationName = '0025_payments_service.sql';
const security = await bundle(new URL('../../security-worker/src/index.js', import.meta.url), '\nexport {validateServiceLinks,ensurePrimaryAdminRecords,validatePasskeySession,passkeyRollingSession,redeemHandoff};');
function baseDb() { const db = new DatabaseSync(':memory:'); for (const file of readdirSync(directory).filter(n => n.endsWith('.sql') && n < migrationName).sort()) db.exec(readFileSync(new URL(file, directory), 'utf8')); return db; }
const apply = db => db.exec(readFileSync(new URL(migrationName, directory), 'utf8'));
function seed(db) {
  db.prepare("INSERT INTO security_identities (id,display_name,status,is_security_admin) VALUES (?,?,'active',1)").run('primary-admin', 'Sample Admin');
  db.prepare("INSERT INTO security_credentials (credential_id,identity_id,public_key,prf_salt,status) VALUES (?,'primary-admin','AQI','YWJj','active')").run('credential-a');
  db.prepare("INSERT INTO security_service_links (id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES (?,'primary-admin','cloud','folder-member',7,'Sample folder','active')").run('link-a');
  db.prepare("INSERT INTO security_handoffs (id,token_hash,identity_id,service_link_id,credential_id,expires_at,cloud_folder_scopes) VALUES (?,'sample-hash','primary-admin','link-a','credential-a',?,'[7,8]')").run('handoff-a', Math.floor(Date.now()/1000)+60);
  db.prepare("INSERT INTO security_tcloud_key_envelopes (id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key) VALUES ('envelope-a','primary-admin','credential-a','link-a','folder_key_rsa','synthetic-encrypted-payload')").run();
  db.prepare("INSERT INTO security_active_sessions(session_id_hash,identity_id,service,service_link_id,service_account_id,credential_id,role,auth_method,session_version,started_at,last_seen_at,expires_at,cloud_folder_scopes) VALUES ('session-a','primary-admin','cloud','link-a','folder-member','credential-a','folder-member','passkey','1','2026-01-01','2026-01-01',?,'[7,8]')").run(Math.floor(Date.now()/1000)+43200);
  db.exec("INSERT INTO security_health_members VALUES ('owner','primary-admin'); INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status) VALUES ('health-link','primary-admin','health','nobumi','Sample','active'); INSERT INTO security_health_grants VALUES ('primary-admin','credential-a','health-link','synthetic-wrapped-key');");
  db.prepare("INSERT INTO security_audit_events (event_id,occurred_at,service,event_type,outcome,identity_id) VALUES ('audit-a','2026-01-01','cloud','sample','success','primary-admin')").run();
}
test('service migration preserves every existing row, scopes, envelopes and foreign keys without auto-granting Payments', () => {
  const db = baseDb(); try { seed(db); const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const before = Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()]));
    db.exec('BEGIN'); try { apply(db); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; }
    const after = Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()])); assert.deepEqual(after, before);
    apply(db); assert.deepEqual(Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()])), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM security_service_links WHERE service='payments'").get().n, 0);
  } finally { db.close(); }
});

test('migration works with enforced foreign keys and keeps health membership and owner restrictions', () => {
  const db = baseDb(); try {
    seed(db); db.exec('PRAGMA foreign_keys=ON; BEGIN');
    try { apply(db); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    assert.equal(db.prepare('SELECT wrapped_key FROM security_health_grants').get().wrapped_key, 'synthetic-wrapped-key');
    assert.throws(() => db.exec("INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label) VALUES ('bad-payment','primary-admin','payments','other','Sample')"), /payments owner required/);
    assert.throws(() => db.exec("INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label) VALUES ('bad-health','primary-admin','health','other','Sample')"), /health membership required/);
  } finally { db.close(); }
});
test('only a freshly authenticated primary admin can link Payments to themself, never through invitations', async () => {
  const db = baseDb(), f = fixture(); try { seed(db); apply(db);
    const env = { DB: d1(db), SESSION_SECRET: randomBytes(32).toString('hex'), PAYMENTS_AUTH: new payments.SecurityIntegration({}, f.env) };
    const admin = { identityId: 'primary-admin', authenticatedAt: Math.floor(Date.now()/1000) }, input = [{ service: 'payments', accountId: 'owner' }];
    assert.equal((await security.validateServiceLinks(env, input, { identityId: 'primary-admin', admin }))[0].role, 'owner');
    await assert.rejects(security.validateServiceLinks(env, input, { identityId: 'someone-else', admin }), e => e.status === 403);
    await assert.rejects(security.validateServiceLinks(env, input, { identityId: 'primary-admin', admin, invitation: true }), e => e.status === 403);
    await assert.rejects(security.validateServiceLinks(env, input, { identityId: 'primary-admin', admin: { ...admin, authenticatedAt: admin.authenticatedAt - 301 } }), e => e.status === 428);
    await security.ensurePrimaryAdminRecords(env); assert.equal(db.prepare("SELECT COUNT(*) n FROM security_service_links WHERE service='payments'").get().n, 0);
  } finally { db.close(); f.close(); }
});
test('real Security rolling ledger validates Payments runtime and link revocation', async () => {
  const db = baseDb(), f = fixture(); try { seed(db); apply(db);
    db.exec("INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status) VALUES ('payments-link','primary-admin','payments','owner','Sample Owner','active')");
    const env = { DB: d1(db), SESSION_SECRET: randomBytes(32).toString('hex'), PASSKEY_ENABLED: 'true', PAYMENTS_AUTH: new payments.SecurityIntegration({}, f.env) };
    f.env.SECURITY.passkeyRollingSession = input => security.passkeyRollingSession(env, input);
    f.env.SECURITY.redeemHandoff = async (_, service) => service === 'payments' ? { identityId: 'primary-admin', serviceAccountId: 'owner', credentialId: 'credential-a', serviceLinkId: 'payments-link', sessionEpoch: 1 } : null;
    const response = await f.login(); assert.equal(response.status, 200); assert.equal((await f.request('/api/entries')).status, 200);
    assert.equal((await f.request('/api/entries', undefined, { 'X-Troom-Activity': 'foreground' })).status, 200);
    db.exec("UPDATE security_service_links SET status='disabled' WHERE id='payments-link'"); assert.equal((await f.request('/api/entries')).status, 401);
  } finally { db.close(); f.close(); }
});

test('real Security handoffs reject foreign services, expired/consumed tokens and replay', async () => {
  const db=baseDb(), f=fixture(); try {seed(db); apply(db);
    db.exec("INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status) VALUES ('payments-link','primary-admin','payments','owner','Sample Owner','active')");
    const env={DB:d1(db),SESSION_SECRET:randomBytes(32).toString('hex'),PASSKEY_ENABLED:'true',PAYMENTS_AUTH:new payments.SecurityIntegration({},f.env)};
    f.env.SECURITY.redeemHandoff=(token,service)=>security.redeemHandoff(env,token,service);
    f.env.SECURITY.passkeyRollingSession=input=>security.passkeyRollingSession(env,input);
    async function token(id, link='payments-link', expires=Math.floor(Date.now()/1000)+60, consumed=null) {
      const value=`synthetic-handoff-${id}`;
      const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
      db.prepare('INSERT INTO security_handoffs(id,token_hash,identity_id,service_link_id,credential_id,expires_at,consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id,hash,'primary-admin',link,'credential-a',expires,consumed); return value;
    }
    for (const value of [await token('foreign','link-a'),await token('expired','payments-link',1),await token('consumed','payments-link',Math.floor(Date.now()/1000)+60,1),'unknown-handoff']) {
      assert.equal((await f.request('/api/passkey/handoff',{handoffToken:value})).status,401);
    }
    const valid=await token('valid'); const response=await f.request('/api/passkey/handoff',{handoffToken:valid}); assert.equal(response.status,200);
    f.cookie=response.headers.get('Set-Cookie').split(';')[0]; assert.equal((await f.request('/api/entries')).status,200);
    assert.equal((await f.request('/api/passkey/handoff',{handoffToken:valid})).status,401);
    db.exec("UPDATE security_credentials SET status='revoked' WHERE credential_id='credential-a'"); assert.equal((await f.request('/api/entries')).status,401);
  } finally {db.close(); f.close();}
});
