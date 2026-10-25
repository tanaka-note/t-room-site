import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { context, env, api } from './session-fixture.mjs';
import { attachPasskeyLedger, seedMultiFolderHandoff } from './passkey-ledger-fixture.mjs';

const queries = [];
const db = attachPasskeyLedger(env, { realValidation: true, onQuery: sql => queries.push(sql) });
try {
  seedMultiFolderHandoff(db);
  db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('admin-link','primary-admin','cloud','admin','Fixture','active')");
  const token = 'admin-performance';
  db.prepare("INSERT INTO security_handoffs(id,token_hash,identity_id,credential_id,service_link_id,session_epoch,expires_at) VALUES('admin-performance',?,'primary-admin','Y3JlZGVudGlhbA','admin-link',1,?)")
    .run(createHash('sha256').update(token).digest('base64url'), Math.floor(Date.now() / 1000) + 60);
  const rpc = env.SECURITY.cloudPasskeySession, actions = [];
  env.SECURITY.cloudPasskeySession = input => { actions.push(input.action); return rpc(input); };
  for (const [mode, handoffToken, reads] of [['admin', token, 3], ['member', 'cloud-member', 4]]) {
    const login = await api(null, '/passkey/handoff', 'POST', { handoffToken });
    assert.equal(login.status, 200);
    const id = login.body.sessionCacheId;
    for (const active of [false, true]) {
      actions.length = 0; queries.length = 0;
      const response = await api(login.cookie, '/items', 'GET', undefined, { 'X-TCloud-Session': id, ...(active ? { 'X-TCloud-Activity': 'foreground' } : {}) });
      assert.equal(response.status, 200);
      assert.deepEqual(actions, active ? ['read', 'touch'] : ['read']);
      assert.equal(queries.length, active ? 2 * reads + 1 : reads, mode);
      assert.ok(queries.every(sql => !/INSERT INTO security_runtime_state/.test(sql)));
    }
    const request = new Request('https://example.test/cloud/api/items', { headers: { Cookie: login.cookie,
      'X-TCloud-Session': id, 'X-TCloud-Activity': 'foreground' } });
    assert.equal((await context.worker.fetch(request, env, { waitUntil() {} })).status, 200);
    // A new invocation must not use a previous invocation's successful result.
    db.exec('SAVEPOINT revoke');
    db.exec("UPDATE security_credentials SET status='revoked'");
    assert.equal((await context.worker.fetch(request, env, { waitUntil() {} })).status, 401);
    db.exec('ROLLBACK TO revoke; RELEASE revoke');
    env.SECURITY.cloudPasskeySession = input => {
      if (input.action === 'touch') db.exec("UPDATE security_credentials SET status='revoked'");
      return rpc(input);
    };
    const denied = await api(login.cookie, '/items', 'GET', undefined, { 'X-TCloud-Session': id, 'X-TCloud-Activity': 'foreground' });
    assert.equal(denied.status, 401);
    assert.equal(denied.cookie, undefined);
    assert.equal(denied.body.folders, undefined);
    db.exec("UPDATE security_credentials SET status='active'");
    env.SECURITY.cloudPasskeySession = input => { actions.push(input.action); return rpc(input); };
  }
  console.log('PASS Cloud auth performance: admin 2 RPC/7 SQL, member 2 RPC/9 SQL; live final touch and cross-request revocation');
} finally { db.close(); }
