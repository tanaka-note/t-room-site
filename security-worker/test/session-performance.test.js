import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../billing-worker/test/performance-fixture.mjs';

function session(f, service = 'billing') {
  const link = `performance-${service}`;
  const identityId = service === 'payments' ? 'primary-admin' : 'fixture-identity';
  const credentialId = service === 'payments' ? 'cHJpbWFyeQ' : 'Y3JlZGVudGlhbA';
  if (service === 'payments') f.securityDb.exec("INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture','active',1); INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('cHJpbWFyeQ','primary-admin','AQI','AQI','active')");
  if (service === 'billing') f.securityDb.prepare("UPDATE security_service_links SET id=? WHERE id='link-owner'").run(link);
  else f.securityDb.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES(?,?,?,'owner','Fixture','active')").run(link, identityId, service);
  return { service, identityId, credentialId, serviceLinkId: link,
    serviceAccountId: 'owner', sessionIdHash: randomBytes(32).toString('base64url'), role: 'owner', sessionVersion: '1',
    sessionEpoch: 1, startedAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 43200, ttlSeconds: 43200 };
}

for (const service of ['diary', 'billing', 'ai', 'downloader', 'downloader2', 'inventory', 'payments']) {
  test(`${service}: live read is one SQL, touch is two, and neither initializes runtime`, async () => {
    const f = fixture();
    try {
      const claims = session(f, service);
      assert.equal((await f.security.passkeyRollingSession({ ...claims, action: 'register' })).valid, true);
      for (const [action, count] of [['read', 1], ['touch', 2]]) {
        f.reset();
        assert.equal((await f.security.passkeyRollingSession({ ...claims, action })).valid, true);
        assert.equal(f.metrics.security.sql.length, count);
        assert.ok(f.metrics.security.sql.every(q => !/INSERT INTO security_runtime_state/.test(q.sql)));
      }
      f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
      assert.equal((await f.security.passkeyRollingSession({ ...claims, action: 'touch' })).valid, false, 'read result is never reused for renewal');
    } finally { f.close(); }
  });
}

const changes = [
  "UPDATE security_identities SET status='disabled'",
  "UPDATE security_credentials SET status='revoked'",
  "UPDATE security_service_links SET status='disabled' WHERE id='performance-billing'",
  "UPDATE security_service_links SET service_account_id='other' WHERE id='performance-billing'",
  'UPDATE security_runtime_state SET passkey_session_epoch=2',
  'UPDATE security_runtime_state SET switch_observed_enabled=0',
  "UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP",
  'UPDATE security_active_sessions SET expires_at=0',
  "UPDATE security_active_sessions SET session_version='other'"
];
for (const sql of changes) test(`joined validation rejects ${sql.split(' SET ')[1]}`, async () => {
  const f = fixture();
  try {
    const claims = session(f);
    await f.security.passkeyRollingSession({ ...claims, action: 'register' });
    f.securityDb.exec(sql);
    for (const action of ['read', 'touch']) assert.equal((await f.security.passkeyRollingSession({ ...claims, action })).valid, false);
  } finally { f.close(); }
});

test('normal validation only reads runtime; lazy initialization and Secret OFF preserve epoch invalidation', async () => {
  const f = fixture();
  try {
    const claims = session(f);
    f.reset();
    assert.equal((await f.security.validatePasskeySession(claims)).valid, true);
    assert.equal(f.metrics.security.sql.length, 2);
    assert.ok(f.metrics.security.sql.every(q => !/INSERT INTO security_runtime_state/.test(q.sql)));
    f.securityDb.exec('DELETE FROM security_runtime_state');
    assert.equal((await f.security.validatePasskeySession(claims)).valid, true);
    assert.equal(f.securityDb.prepare('SELECT passkey_session_epoch FROM security_runtime_state').get().passkey_session_epoch, 1);
    f.security.env.PASSKEY_ENABLED = 'false';
    assert.equal((await f.security.validatePasskeySession(claims)).valid, false);
    assert.equal((await f.security.validatePasskeySession(claims)).valid, false);
    assert.equal(f.securityDb.prepare('SELECT passkey_session_epoch FROM security_runtime_state').get().passkey_session_epoch, 2);
    f.security.env.PASSKEY_ENABLED = 'true';
    assert.equal((await f.security.validatePasskeySession({ ...claims, sessionEpoch: 2 })).valid, false, 'Secret ON alone never reopens the gate');
  } finally { f.close(); }
});

test('joined ledger never accepts altered binding, role, version, service or Cloud claims', async () => {
  const f = fixture();
  try {
    const claims = session(f);
    await f.security.passkeyRollingSession({ ...claims, action: 'register' });
    for (const extra of [{ identityId: 'other' }, { credentialId: 'b3RoZXI' }, { serviceLinkId: 'link-owner' },
      { serviceAccountId: 'other' }, { role: 'other' }, { sessionVersion: 'other' }, { service: 'diary' },
      { sessionIdHash: randomBytes(32).toString('base64url') }, { cloudRootFolderId: 7 }, { cloudScopeId: 'scope' }, { folderScopes: [] }]) {
      assert.equal((await f.security.passkeyRollingSession({ ...claims, ...extra, action: 'read' })).valid, false);
    }
    await f.security.passkeyRollingSession({ ...claims, action: 'end' });
    assert.equal((await f.security.passkeyRollingSession({ ...claims, action: 'register' })).valid, false);
  } finally { f.close(); }
});
