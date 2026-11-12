import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { systemFixture } from './system-fixture.mjs';
import { entry } from './fixture.mjs';
import { memoryDatabase } from './sqlite.mjs';
import { EncryptedDiaryClient } from '../../e2ee/client.mjs';
import { readSnapshotPages } from '../../e2ee/snapshot.mjs';
import { backup, restoreEmpty } from '../../e2ee/backup.mjs';
import { bindingOf } from '../../e2ee/record.mjs';
import { prepareKeyConfiguration, publicTrustPackage } from '../../e2ee/setup.mjs';
import { openRecoveryEnvelope } from '../../e2ee/recovery.mjs';
import { createVault, open, signed, unb64, validatePublicTrust } from '../../e2ee/crypto.mjs';
import { diaryRecipientId, diaryKeyBundle, handleDiaryKeys } from '../../../security-worker/src/diary-keys.js';

let f;
before(async () => { f = await systemFixture(); });
after(async () => { await f.close(); });
const owner = () => f.users['main-admin'];
async function central(path, body, actor = owner()) {
  return handleDiaryKeys(`/api/diary${path}`, new Request(`https://fixture.test/security/api/diary${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : {body:JSON.stringify(body), headers:{'Content-Type':'application/json'}}),
  }), f.centralEnv, {...actor, authenticatedAt:Date.now()/1000}, f.helpers);
}
async function request(user, path, method = 'GET', body) {
  const origin = f.env.DIARY_ENCRYPTION_ORIGIN;
  const response = await f.worker.fetch(new Request(`${origin}/diary/api/encryption${path}`, {
    method, headers:{Cookie:f.cookie(user.serviceAccountId, user), ...(method === 'GET' ? {} : {
      Origin:origin, 'X-Diary-Request':'1', 'Content-Type':'application/json',
    })}, ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  }), f.env, f.ctx);
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error), {status:response.status});
  return value;
}
async function client(user = owner()) {
  const {profile} = await request(user, '/profile');
  const transport = {
    valid:async () => true,
    timestamp:async () => (await request(user, '/time')).timestamp,
    snapshot:(h,since) => readSnapshotPages(options => request(user, `/snapshot?${new URLSearchParams(Object.entries(options).filter(([,v]) => v !== null))}`), h, since),
    mutation:(proposal,operation) => request(user, '/mutation', 'POST', {proposal,operation}),
    remove:value => request(user, '/remove', 'POST', value),
  };
  const result = new EncryptedDiaryClient({profile, transport, anchor:f.configuration.anchor});
  await result.unlock(new Uint8Array(user.prf));
  return result;
}
async function nextConfiguration() {
  const status = await (await central('/admin')).json(), recoveryRecords = [];
  let after = '';
  do {
    const page = await (await central(`/recovery-records${after ? `?after=${encodeURIComponent(after)}` : ''}`)).json();
    recoveryRecords.push(...page.records); after = page.nextCursor;
  } while (after);
  return prepareKeyConfiguration({status, recoveryPrivateKey:f.recovery.privateKey,
    trustedAnchor:f.configuration.anchor, recoveryRecords});
}

test('an exact saved configuration retry succeeds without another generation or grants', async () => {
  const before = f.central.sqlite.prepare('SELECT COUNT(*) count FROM security_diary_key_grants').get().count;
  assert.equal((await central('/config', f.configuration)).status, 200);
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation, 1);
  assert.equal(f.central.sqlite.prepare('SELECT COUNT(*) count FROM security_diary_key_grants').get().count, before);
  const changed = structuredClone(f.configuration);
  changed.grants[owner().recipientId][0].value.wrapped = changed.grants[owner().recipientId][1].value.wrapped;
  await assert.rejects(central('/config', changed));
  changed.directory.value.generation++;
  await assert.rejects(central('/config', changed), /DiaryKeyGenerationConflict/);
});

test('public trust refuses private JWKs and unknown secret fields before persistence', async () => {
  const trust = await publicTrustPackage(f.configuration);
  assert.deepEqual(await validatePublicTrust(trust), trust);
  for (const bad of [
    {...trust, recoverySecret:'synthetic-private-canary'},
    {...trust, anchor:{...trust.anchor, d:'synthetic-private-canary'}},
    {...trust, anchor:{...trust.anchor, extra:'synthetic-private-canary'}},
    {...trust, anchor:{...trust.anchor, key_ops:['sign','verify']}},
  ]) await assert.rejects(validatePublicTrust(bad));
  const vault = structuredClone(owner().vault); vault.publicKey.extra = 'synthetic-private-canary';
  await assert.rejects(central('/vault', {serviceLinkId:owner().serviceLinkId, vault}), /InvalidPublicKey/);
  assert.equal(JSON.stringify(f.central.sqlite.prepare('SELECT * FROM security_diary_key_vaults').all()).includes('synthetic-private-canary'), false);
});

test('the existing 3072-bit central key restores encrypted database contents without the original PRF', async () => {
  assert.equal(unb64(f.configuration.recoveryEnvelope.wrappedKey).length, 384);
  const c = await client(), saved = (await c.saveEntry(entry())).entry;
  const packet = await backup(f.db, {directory:f.configuration.directory,
    vaults:{owner:owner().vault}, grants:{owner:f.configuration.grants[owner().recipientId]},
    recoveryEnvelope:f.configuration.recoveryEnvelope});
  const isolated = memoryDatabase();
  try {
    const restored = await restoreEmpty(isolated, packet, {anchor:f.configuration.anchor, minimumGeneration:1});
    const recovered = await openRecoveryEnvelope({packet:restored.recoveryEnvelope,
      recoveryPrivateKey:f.recovery.privateKey, anchor:f.configuration.anchor});
    const row = c.records.get(String(saved.id)).row;
    assert.equal((await open(recovered.scopeKeys.get(row.scope), row.envelope, {...bindingOf(row), kind:'document'})).entry.content, saved.content);
    assert.equal(JSON.stringify(packet).includes(saved.content), false);
    recovered.scopeKeys.clear();
  } finally { isolated.close(); c.lock(); }
});

test('revocation, role, household and trash-scope changes stop actual Worker writes', async () => {
  const original = f.integration.describeEncryptionAccount.bind(f.integration);
  for (const change of [
    claims => ({...claims, canManageEntries:false}),
    claims => ({...claims, households:['chiharu-household']}),
    claims => ({...claims, canViewTrash:false}),
  ]) {
    const c = await client();
    f.integration.describeEncryptionAccount = async input => {
      const claims = await original(input); return input.accountId === 'wife-admin' ? change(claims) : claims;
    };
    try {
      assert.equal((await diaryKeyBundle(f.centralEnv, owner())).rekeyRequired, true);
      await assert.rejects(c.saveEntry(entry()), error => error.status === 423);
      await assert.rejects(nextConfiguration(), /RekeyRequired/);
    } finally { f.integration.describeEncryptionAccount = original; c.lock(); }
  }
  f.central.sqlite.prepare("UPDATE security_service_links SET status='disabled' WHERE id=?").run(f.users['wife-admin'].serviceLinkId);
  try {
    const c = await client();
    assert.equal((await diaryKeyBundle(f.centralEnv, owner())).rekeyRequired, true);
    await assert.rejects(c.saveEntry(entry()), error => error.status === 423); c.lock();
  } finally { f.central.sqlite.prepare("UPDATE security_service_links SET status='active' WHERE id=?").run(f.users['wife-admin'].serviceLinkId); }
});

test('approved replacement passkey recovers narrowed trash across successive key generations', async () => {
  const editor = f.users['wife-admin'], c = await client(editor), admin = await client();
  const saved = (await c.saveEntry(entry())).entry;
  await c.transition(saved.id, 'trash'); await admin.sync(); await admin.transition(saved.id, 'purge');
  const credentialId = 'fixture-recovered-editor', prf = crypto.getRandomValues(new Uint8Array(32));
  f.central.sqlite.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES(?,?,'public-fixture','salt-fixture','active',1)").run(credentialId, editor.identityId);
  const recipientId = await diaryRecipientId(credentialId, editor.serviceLinkId);
  const replacement = {...editor, credentialId, recipientId, prf, vault:await createVault(prf, recipientId)};
  try {
    await central('/vault', {serviceLinkId:editor.serviceLinkId, vault:replacement.vault}, replacement);
    const configuration = await nextConfiguration();
    assert.ok(configuration.recordGrants[recipientId].some(packet => packet.value.id === String(saved.id)));
    const missing = structuredClone(configuration); missing.recordGrants[recipientId] = [];
    await assert.rejects(central('/config', missing), /IncompleteRecordGrants/);
    const badGrant = structuredClone(configuration);
    const recovered = await openRecoveryEnvelope({packet:f.configuration.recoveryEnvelope, recoveryPrivateKey:f.recovery.privateKey, anchor:f.configuration.anchor});
    const packet = badGrant.grants[recipientId][0];
    packet.value.household = 'chiharu-household';
    badGrant.grants[recipientId][0] = await signed(packet.value, recovered.authority);
    await assert.rejects(central('/config', badGrant), /InvalidGrant/);
    recovered.scopeKeys.clear();
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(credentialId);
    await assert.rejects(central('/config', configuration), /DiaryRecipientMismatch/);
    f.central.sqlite.prepare("UPDATE security_credentials SET status='active' WHERE credential_id=?").run(credentialId);
    await central('/config', configuration);
    const first = await client(replacement); await first.sync();
    assert.equal(first.entry(saved.id).content, saved.content); first.lock();
    const next = await nextConfiguration();
    await central('/config', next);
    const second = await client(replacement); await second.sync();
    assert.equal(second.entry(saved.id).content, saved.content); second.lock();
    assert.equal((await central('/config', next)).status, 200);
    await assert.rejects(central('/config', configuration), /DiaryKeyGenerationConflict/);
  } finally { prf.fill(0); c.lock(); admin.lock(); }
});
