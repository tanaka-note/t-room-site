import test from 'node:test';
import assert from 'node:assert/strict';
import { healthSecurityFixture } from './health-security-fixture.mjs';
import { migrationSql } from './health-migration-fixture.mjs';

test('retired Health rejects existing handoffs and sessions while Diary remains valid', async () => {
  const fixture = await healthSecurityFixture();
  try {
    const { security, health, worker } = fixture;
    const token = fixture.issue();
    const healthSession = { ...health.users.owner.handoff, service: 'health', sessionEpoch: 1 };
    assert.equal(await security.redeemHandoff(token, 'health'), null);
    assert.deepEqual(await security.validatePasskeySession(healthSession), { valid: false });
    assert.equal(await security.getHealthKeyBundle(healthSession), null);
    for (const [path, method] of [['/', 'GET'], ['/api/records', 'GET'], ['/api/passkey/handoff', 'POST']]) {
      const response = await worker.fetch(new Request(`https://tanaka-note.com/health${path}`, { method }));
      assert.equal(response.status, 410);
      assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
    }
    assert.deepEqual(await security.validatePasskeySession({
      service: 'diary', sessionEpoch: 1, identityId: 'fixture-third',
      credentialId: 'fixture-third-AA', serviceLinkId: 'third-link', serviceAccountId: 'fixture-third'
    }), { valid: true });
  } finally { fixture.close(); }
});

test('migration deletes only the retired service links and their dependent rows', async () => {
  const fixture = await healthSecurityFixture();
  try {
    const { db } = fixture;
    const healthToken = fixture.issue();
    const diaryToken = fixture.issue('owner', {
      identityId: 'fixture-third', credentialId: 'fixture-third-AA', serviceLinkId: 'third-link',
    });
    const counts = () => ['security_identities', 'security_credentials', 'security_health_vaults']
      .map(table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const before = counts();
    db.prepare("UPDATE security_service_links SET status = 'disabled' WHERE id = 'link-subject'").run();
    for (let run = 0; run < 2; run++) db.exec(migrationSql('0031_retire_health_links.sql'));
    const links = db.prepare('SELECT id FROM security_service_links').all().map(row => row.id);
    assert.deepEqual(links, ['third-link']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM security_health_grants').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM security_handoffs').get().count, 1);
    assert.equal(await fixture.security.redeemHandoff(healthToken, 'health'), null);
    assert.equal((await fixture.security.redeemHandoff(diaryToken, 'diary')).serviceLinkId, 'third-link');
    assert.deepEqual(counts(), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { fixture.close(); }
});
