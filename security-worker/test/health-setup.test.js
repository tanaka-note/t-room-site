import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { createClientVault, wrapMaster, unwrapMaster, unlockClient } from '../../health-worker/public/health-crypto.mjs';

function client(globals) {
  const source = readFileSync(new URL('../public/health-setup.mjs', import.meta.url), 'utf8')
    .replace(/^import[^\n]+\n/, '').replaceAll('export async function ', 'async function ');
  return runInNewContext(`${source}\n({ prepareHealth, loadHealthApprovals })`, {
    crypto, Uint8Array, createClientVault, wrapMaster, unwrapMaster, ...globals
  });
}

test('Health approval uses the authenticated account and only delegates to the selected identity and link', async () => {
  const accountId = 'fixture-account', prf = randomBytes(32), calls = [], outputs = [];
  const admin = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const publicKey = await crypto.subtle.exportKey('jwk', admin.publicKey), vault = await createClientVault(prf);
  let config = null, wrappedGrant, master;
  const api = client({
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body });
      if (url === '/security/api/health/own') return Response.json({ accountId, prepared: true, ready: true });
      if (url === '/security/api/health/admin') return Response.json({ accountId, config, recoveryPublicKey: publicKey, adminEnvelope: {}, members: [
        { identityId: 'subject', credentialId: 'credential-subject', serviceLinkId: 'link-subject', publicKey: vault.publicKey, granted: false },
        { identityId: 'owner', credentialId: 'credential-owner', serviceLinkId: 'link-owner', publicKey: vault.publicKey, granted: false },
        { identityId: 'subject', credentialId: 'old-credential', serviceLinkId: 'old-link', publicKey: vault.publicKey, granted: false }
      ] });
      if (url === '/security/api/health/initialize') { config = { recoveryWrappedKey: body.recoveryWrappedKey }; return Response.json({ ok: true }); }
      if (url === '/security/api/health/grant') { wrappedGrant = body.wrappedKey; return Response.json({ ok: true }); }
      throw Error('unexpected endpoint');
    },
    TRoomPasskeys: { authenticate: async service => { assert.equal(service, 'security'); const output = new Uint8Array(prf); outputs.push(output); return { prfOutput: output }; } },
    TRoomCrypto: { unlockAdminPrivateKeyWithPasskey: async () => admin.privateKey }
  });
  try {
    const approvals = await api.loadHealthApprovals('subject', 'link-subject');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].credentialId, 'credential-subject');
    assert.equal(calls.filter(call => call.url.endsWith('/grant')).length, 0, 'checking keys cannot approve automatically');
    master = await unwrapMaster(admin.privateKey, config.recoveryWrappedKey, accountId);
    await approvals[0].approve();
    assert.deepEqual(calls.find(call => call.url.endsWith('/grant')).body, { credentialId: 'credential-subject', serviceLinkId: 'link-subject', wrappedKey: wrappedGrant });
    const delegated = await unwrapMaster(await unlockClient(prf, vault), wrappedGrant, accountId);
    assert.deepEqual(delegated, master); delegated.fill(0);
    await api.loadHealthApprovals('subject', 'link-subject');
    assert.equal(calls.filter(call => call.url.endsWith('/initialize')).length, 1);
    assert.equal(outputs.length, 3, 'delegation requires its own fresh passkey authentication');
    for (const output of outputs) assert.ok(output.every(value => value === 0));
  } finally { master?.fill(0); prf.fill(0); }
});

test('Health self preparation creates only a missing vault and never creates a handoff or grant', async () => {
  for (const prepared of [false, true]) {
    const calls = [], output = randomBytes(32);
    const api = client({
      TRoomPasskeys: { authenticate: async (service, choose, options) => {
        assert.equal(service, 'health'); assert.equal(options.handoff, false); return { prfOutput: output };
      } },
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith('/own')) return Response.json({ prepared, ready: prepared });
        if (url.endsWith('/vault')) return Response.json({ ok: true });
        throw Error('unexpected endpoint');
      }
    });
    const result = await api.prepareHealth();
    assert.equal(result.ready, prepared);
    assert.equal(calls.filter(call => call.url.endsWith('/vault')).length, Number(!prepared));
    assert.ok(output.every(value => value === 0));
  }
});

test('Health setup stops on unconfirmed responses and wipes PRF output on failure', async () => {
  const cases = [
    ['<html>gateway error</html>', 'text/html', 200], ['', 'application/json', 200], ['{', 'application/json', 200],
    ['[]', 'application/json', 200], ['null', 'application/json', 200], ['<html>gateway error</html>', 'text/html', 502],
    ['<html>login expired</html>', 'text/html', 401], ['{"error":"連携を確認してください。"}', 'application/json', 409],
    ['{"error":""}', 'application/json', 502], ['', 'network', 0]
  ];
  for (const [body, type, status] of cases) {
    let requests = 0;
    const output = randomBytes(32);
    const api = client({
      fetch: async () => { requests++; if (type === 'network') throw new TypeError('Failed to fetch'); return new Response(body, { status, headers: { 'Content-Type': type } }); },
      TRoomPasskeys: { authenticate: async () => ({ prfOutput: output }) }
    });
    await assert.rejects(api.prepareHealth(), error => {
      assert.match(error.message, status === 401 ? /パスキー/ : status === 409 ? /連携を確認/ : /処理結果を確認/);
      assert.doesNotMatch(error.message, /Unexpected|JSON|gateway|<html>/); return true;
    });
    assert.equal(requests, 1);
    assert.ok(output.every(value => value === 0));
  }
});
