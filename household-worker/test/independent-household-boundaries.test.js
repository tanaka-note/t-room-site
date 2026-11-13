import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, household} from './fixture.js';

const recordId = () => crypto.randomUUID();
function family() {
  const owner = fixture();
  const chiharu = fixture('chiharu-admin', 'sample-chiharu');
  const viewer = fixture('viewer');
  chiharu.env.DB = viewer.env.DB = owner.env.DB;
  return {
    owner, chiharu, viewer, db: owner.sqlite,
    async login() { await owner.login(); await chiharu.login(); await viewer.login(); },
    close() { owner.close(); chiharu.close(); viewer.close(); },
  };
}
function expense(id, description) {
  return {id, date: '2026-10-31', type: 'expense', amount: 123, categoryId: 'builtin-1-0', description};
}
async function signedScopeCookie(client, householdId) {
  const token = client.cookie.split('=')[1];
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  return 'troom_household_session=' + await household.signSession({...payload, householdId}, client.env);
}

test('a signed but forged householdId never overrides the server-side account; identical record IDs remain isolated', async () => {
  const f = family();
  try {
    await f.login();
    const sharedId = recordId();
    assert.equal((await f.owner.mutate('transaction.save', expense(sharedId, 'ORIGINAL-ONLY'))).status, 200);
    assert.equal((await f.chiharu.mutate('transaction.save', expense(sharedId, 'CHIHARU-ONLY'))).status, 200);
    f.owner.cookie = await signedScopeCookie(f.owner, 'chiharu');
    f.chiharu.cookie = await signedScopeCookie(f.chiharu, 'main');

    const original = await f.owner.state();
    const independent = await f.chiharu.state();
    assert.deepEqual(original.data.transactions.map(t => t.description), ['ORIGINAL-ONLY']);
    assert.deepEqual(independent.data.transactions.map(t => t.description), ['CHIHARU-ONLY']);
    assert.deepEqual((await f.viewer.state()).data, original.data);
    assert.deepEqual((await (await f.owner.request('/api/data?householdId=chiharu')).json()).data, original.data);
    assert.deepEqual((await (await f.chiharu.request('/api/data?householdId=main')).json()).data, independent.data);

    for (const [client, own, foreign] of [
      [f.owner, 'ORIGINAL-ONLY', 'CHIHARU-ONLY'],
      [f.chiharu, 'CHIHARU-ONLY', 'ORIGINAL-ONLY'],
      [f.viewer, 'ORIGINAL-ONLY', 'CHIHARU-ONLY'],
    ]) {
      for (const path of ['/api/backup', '/api/export.csv']) {
        const response = await client.request(path);
        assert.equal(response.status, 200, path);
        const body = await response.text();
        assert.ok(body.includes(own), `${path} missing own data`);
        assert.ok(!body.includes(foreign), `${path} leaked another household`);
      }
    }
    assert.equal((await f.chiharu.mutate('transaction.delete', {id: sharedId}, {householdId: 'main', serviceAccountId: 'owner'})).status, 200);
    assert.equal((await f.chiharu.state()).data.transactions.length, 0);
    assert.deepEqual((await f.owner.state()).data, original.data);
  } finally { f.close(); }
});

test('current sessions require their own context on protected APIs and reject swapped tab contexts', async () => {
  const f = family();
  try {
    await f.login();
    const originalContext = (await (await f.owner.request('/api/session')).json()).sessionContext;
    const independentContext = (await (await f.chiharu.request('/api/session')).json()).sessionContext;
    assert.notEqual(originalContext, independentContext);
    for (const [client, foreignContext] of [[f.owner, independentContext], [f.chiharu, originalContext]]) {
      for (const header of ['', foreignContext]) {
        for (const path of ['/api/data', '/api/backup', '/api/export.csv', '/api/maintenance/preview']) {
          assert.equal((await client.request(path, undefined, {'X-Household-Session': header})).status, 401, path);
        }
        for (const path of ['/api/mutate', '/api/restore', '/api/maintenance', '/api/logout']) {
          assert.equal((await client.request(path, {}, {'X-Household-Session': header})).status, 401, path);
        }
      }
      assert.equal((await client.request('/api/data')).status, 200);
    }
  } finally { f.close(); }
});

test('revoking only the independent editor invalidates its existing session without disabling the original or viewer', async () => {
  const f = family();
  try {
    await f.login();
    f.db.prepare("UPDATE household_accounts SET session_version=session_version+1 WHERE id='chiharu-admin'").run();
    assert.equal((await f.chiharu.request('/api/session')).status, 401);
    assert.equal((await f.chiharu.request('/api/data')).status, 401);
    assert.equal((await f.chiharu.request('/api/backup')).status, 401);
    assert.equal((await f.owner.request('/api/data')).status, 200);
    assert.equal((await f.viewer.request('/api/data')).status, 200);
    const provider = new household.SecurityIntegration({}, f.owner.env);
    const state = await provider.getSessionRuntimeState({serviceAccountId: 'chiharu-admin'});
    assert.equal(state.sessionVersion, '1:2');
  } finally { f.close(); }
});

test('an unissued handoff cannot authenticate the new independent editor', async () => {
  const f = fixture('chiharu-admin', 'sample-chiharu');
  try {
    assert.equal((await f.request('/api/passkey/handoff', {handoffToken: 'not-issued'})).status, 401);
    for (const path of ['/api/session', '/api/data', '/api/backup', '/api/export.csv', '/api/maintenance/preview']) {
      assert.equal((await f.request(path)).status, 401, path);
    }
    for (const path of ['/api/mutate', '/api/restore', '/api/maintenance']) {
      assert.equal((await f.request(path, {})).status, 401, path);
    }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM household_records WHERE dataset_id='chiharu-initial' AND kind!='categories'").get().n, 0);
  } finally { f.close(); }
});
