import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { healthSecurityFixture } from './health-security-fixture.mjs';
import { migrationSql } from './health-migration-fixture.mjs';

const retired = ['downloader', 'downloader2', 'ai'];
const origin = 'https://tanaka-note.com';
const diary = {
  service: 'diary', sessionEpoch: 1, identityId: 'fixture-third',
  credentialId: 'fixture-third-AA', serviceLinkId: 'third-link', serviceAccountId: 'fixture-third'
};

function seedRetirement(fixture) {
  const { db } = fixture;
  const owner = fixture.health.users.owner.handoff;
  const addLink = db.prepare("INSERT INTO security_service_links(id, identity_id, service, service_account_id, display_label, status) VALUES (?, ?, ?, 'owner', ?, ?)");
  const addInvitation = db.prepare("INSERT INTO security_invitations(id, identity_id, token_hash, link_set_hash, expires_at) VALUES (?, ?, ?, 'fixture', 4102444800)");
  const addSession = db.prepare("INSERT INTO security_active_sessions(session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id, role, auth_method, session_version, started_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'owner', 'passkey', '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 4102444800)");
  const addChallenge = db.prepare("INSERT INTO security_challenges(id, purpose, challenge_hash, service, expires_at) VALUES (?, 'authentication', ?, ?, 4102444800)");
  addInvitation.run('owner-invitation', owner.identityId, 'owner-token');
  addInvitation.run('diary-invitation', diary.identityId, 'diary-token');
  for (const [index, service] of retired.entries()) {
    const id = service + '-link';
    addLink.run(id, owner.identityId, service, service, ['active', 'pending', 'disabled'][index]);
    addSession.run(service + '-session', owner.identityId, service, id, 'owner', owner.credentialId);
    addChallenge.run(service + '-challenge', service + '-challenge-hash', service);
  }
  addSession.run('diary-session', diary.identityId, diary.service, diary.serviceLinkId, diary.serviceAccountId, diary.credentialId);
  addChallenge.run('diary-challenge', 'diary-challenge-hash', 'diary');
  return owner;
}

test('retired services reject handoffs, sessions and new passkey requests before migration', async () => {
  const fixture = await healthSecurityFixture();
  try {
    const { security } = fixture;
    security.env.SESSION_SECRET = randomBytes(32).toString('hex');
    const owner = seedRetirement(fixture);
    for (const service of retired) {
      const serviceLinkId = service + '-link';
      const token = fixture.issue('owner', { serviceLinkId });
      assert.equal(await security.redeemHandoff(token, service), null);
      assert.deepEqual(await security.validatePasskeySession({
        service, identityId: owner.identityId, credentialId: owner.credentialId,
        serviceLinkId, serviceAccountId: 'owner', sessionEpoch: 1
      }), { valid: false });
      const response = await security.fetch(new Request(origin + '/security/api/auth/options', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ service })
      }));
      assert.equal(response.status, 400, service);
    }
    const oldAi = await security.fetch(new Request(origin + '/security/api/ai/budgets'));
    assert.equal(oldAi.status, 410);
    assert.deepEqual(await security.validatePasskeySession(diary), { valid: true });
  } finally { fixture.close(); }
});

test('retirement migration is scoped and repeatable with foreign keys enabled', async () => {
  const fixture = await healthSecurityFixture();
  try {
    const { db, security } = fixture;
    seedRetirement(fixture);
    for (const service of retired) fixture.issue('owner', { serviceLinkId: service + '-link' });
    const preservedHandoff = fixture.issue('owner', diary);
    db.exec("INSERT INTO security_audit_events(event_id, occurred_at, service, event_type, outcome, service_link_id) VALUES ('audit', CURRENT_TIMESTAMP, 'downloader', 'download', 'success', 'downloader-link')");
    const protectedTables = ['security_identities', 'security_credentials', 'security_health_vaults', 'security_audit_events'];
    const snapshot = () => protectedTables.map(name => db.prepare('SELECT * FROM ' + name).all());
    const before = snapshot();
    const sql = migrationSql('0032_retire_downloader_ai_links.sql');
    db.exec(sql);
    db.exec(sql);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare('SELECT service FROM security_service_links ORDER BY service').all().map(row => row.service), ['diary', 'health', 'health']);
    assert.deepEqual(db.prepare('SELECT service FROM security_active_sessions').all().map(row => row.service), ['diary']);
    assert.deepEqual(db.prepare('SELECT service FROM security_challenges').all().map(row => row.service), ['diary']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM security_handoffs').get().count, 1);
    assert.equal(db.prepare("SELECT status FROM security_invitations WHERE id='owner-invitation'").get().status, 'revoked');
    assert.equal(db.prepare("SELECT status FROM security_invitations WHERE id='diary-invitation'").get().status, 'active');
    assert.equal((await security.redeemHandoff(preservedHandoff, 'diary')).serviceLinkId, diary.serviceLinkId);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { fixture.close(); }
});
