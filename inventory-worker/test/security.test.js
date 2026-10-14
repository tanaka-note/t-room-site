import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { bundle, d1, fixture, inventory } from './fixture.js';
const directory = new URL('../../security-worker/migrations/', import.meta.url);
const migrationName = '0022_inventory_service.sql';
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
  db.prepare("INSERT INTO security_audit_events (event_id,occurred_at,service,event_type,outcome,identity_id) VALUES ('audit-a','2026-01-01','cloud','sample','success','primary-admin')").run();
}
test('service migration preserves every existing row, scopes, envelopes and foreign keys without auto-granting Inventory', () => {
  const db = baseDb(); try { seed(db); const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const before = Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()]));
    db.exec('BEGIN'); try { apply(db); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); db.exec('COMMIT'); } catch(e) { db.exec('ROLLBACK'); throw e; }
    const after = Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()])); assert.deepEqual(after, before);
    apply(db); assert.deepEqual(Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()])), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM security_service_links WHERE service='inventory'").get().n, 0);
  } finally { db.close(); }
});
test('only a freshly authenticated primary admin can link Inventory to themself, never through invitations', async () => {
  const db = baseDb(), f = fixture(); try { seed(db); apply(db);
    const env = { DB: d1(db), SESSION_SECRET: randomBytes(32).toString('hex'), INVENTORY_AUTH: new inventory.SecurityIntegration({}, f.env) };
    const admin = { identityId: 'primary-admin', authenticatedAt: Math.floor(Date.now()/1000) }, input = [{ service: 'inventory', accountId: 'owner' }];
    assert.equal((await security.validateServiceLinks(env, input, { identityId: 'primary-admin', admin }))[0].role, 'owner');
    await assert.rejects(security.validateServiceLinks(env, input, { identityId: 'someone-else', admin }), e => e.status === 403);
    await assert.rejects(security.validateServiceLinks(env, input, { identityId: 'primary-admin', admin, invitation: true }), e => e.status === 403);
    await assert.rejects(security.validateServiceLinks(env, input, { identityId: 'primary-admin', admin: { ...admin, authenticatedAt: admin.authenticatedAt - 301 } }), e => e.status === 428);
    await security.ensurePrimaryAdminRecords(env); assert.equal(db.prepare("SELECT COUNT(*) n FROM security_service_links WHERE service='inventory'").get().n, 0);
  } finally { db.close(); f.close(); }
});
test('real Security rolling ledger validates Inventory runtime and link revocation', async () => {
  const db = baseDb(), f = fixture(); try { seed(db); apply(db);
    db.exec("INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status) VALUES ('inventory-link','primary-admin','inventory','owner','Sample Owner','active')");
    const env = { DB: d1(db), SESSION_SECRET: randomBytes(32).toString('hex'), PASSKEY_ENABLED: 'true', INVENTORY_AUTH: new inventory.SecurityIntegration({}, f.env) };
    f.env.SECURITY.passkeyRollingSession = input => security.passkeyRollingSession(env, input);
    f.env.SECURITY.redeemHandoff = async (_, service) => service === 'inventory' ? { identityId: 'primary-admin', serviceAccountId: 'owner', credentialId: 'credential-a', serviceLinkId: 'inventory-link', sessionEpoch: 1 } : null;
    const response = await f.login(); assert.equal(response.status, 200); assert.equal((await f.request('/api/items')).status, 200);
    assert.equal((await f.request('/api/items', undefined, { 'X-Troom-Activity': 'foreground' })).status, 200);
    db.exec("UPDATE security_service_links SET status='disabled' WHERE id='inventory-link'"); assert.equal((await f.request('/api/items')).status, 401);
  } finally { db.close(); f.close(); }
});
