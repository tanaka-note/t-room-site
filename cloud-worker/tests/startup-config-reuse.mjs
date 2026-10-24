import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../public/cloud.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const prepare = section('async function prepareCryptoSession(', 'function openVaultDialog(');
const binding = section('function passkeyCacheBinding(', 'function validPasskeyPrivateKey(');
const scopes = section('function validWrappedFolderScopes(', 'async function saveCachedPasskeyKeys(');
const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const folderKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

async function run(options = {}) {
  const role = options.role || 'admin';
  const session = { authMethod: 'passkey', role, sessionCacheId: 'fixture-session', identityId: 'fixture-identity',
    credentialId: 'fixture-credential', serviceLinkId: 'fixture-link', serviceAccountId: role === 'member' ? 'folder-member' : 'admin',
    sessionVersion: '5', passkeySessionEpoch: 1, ...(role === 'member' ? { rootFolderId: 7,
      folderScopes: [{ serviceLinkId: 'fixture-link', rootFolderId: 7 }] } : {}) };
  const config = { initialized: true, cryptoVersion: 1, createdAt: '2026-10-01', publicKeyJwk };
  const freshConfig = options.changedConfig ? { ...config, createdAt: '2026-10-02' } : config;
  const state = { session, crypto: { folderKeys: new Map() } };
  const calls = { api: 0, save: 0, delegated: 0, status: [] };
  const context = vm.createContext({ state, crypto,
    api: async path => {
      assert.equal(path, '/crypto-config'); calls.api++;
      if (options.changeSessionDuringFetch) state.session = { ...session, sessionCacheId: 'replacement' };
      return freshConfig;
    },
    TCloudSession: { check: () => {
      if (options.invalidSession) throw Object.assign(new Error('Synthetic expired session'), { status: 419 });
    } },
    memberFolderScopes: selected => (selected || state.session).folderScopes,
    syncAvailableActions() {}, setNotice() {},
    setCryptoStatus: (...args) => calls.status.push(args),
    saveCachedPasskeyKeys: async () => { calls.save++; },
    TRoomCrypto: { unlockDelegatedFolderKey: async (key, wrapped) => {
      assert.equal(key, pair.privateKey); assert.equal(wrapped, 'synthetic-envelope');
      calls.delegated++; return folderKey;
    } }
  });
  vm.runInContext(binding + scopes + prepare, context);
  const cached = { binding: vm.runInContext('passkeyCacheBinding(state.session, config)',
    Object.assign(context, { config })), privateKey: pair.privateKey,
    wrappedFolderKeys: [{ serviceLinkId: 'fixture-link', rootFolderId: 7, wrappedKey: 'synthetic-envelope' }] };
  assert.ok(cached.binding, 'fixture uses a complete cache binding');
  if (options.badBinding) cached.binding = 'different-binding';
  context.startup = {
    ...(options.noCache ? {} : { cached }),
    ...(options.missingConfig ? {} : { config }),
    ...(options.missingContext ? {} : { configSession: options.otherContext ? { ...session } : session })
  };
  let error;
  try { await vm.runInContext('prepareCryptoSession("", null, startup)', context); }
  catch (caught) { error = caught; }
  return { calls, state, session, config, error };
}

for (const role of ['admin', 'member']) test(`cached ${role} startup uses its already-validated config without a second API`, async () => {
  const result = await run({ role });
  assert.equal(result.error, undefined);
  assert.equal(result.calls.api, 0);
  assert.equal(result.calls.save, 1);
  assert.equal(result.state.crypto.config, result.config);
  if (role === 'admin') assert.equal(result.state.crypto.adminPrivateKey, pair.privateKey);
  else {
    assert.equal(result.calls.delegated, 1);
    assert.equal(result.state.crypto.folderKeys.get(7), folderKey);
  }
});

for (const options of [{ otherContext: true }, { missingContext: true }, { missingConfig: true }]) {
  test(`unbound config gets a fresh authenticated response: ${JSON.stringify(options)}`, async () => {
    const result = await run(options);
    assert.equal(result.error, undefined);
    assert.equal(result.calls.api, 1);
    assert.equal(result.calls.save, 1);
  });
}

test('a fresh login without a validated cached key still fetches config', async () => {
  const result = await run({ noCache: true });
  assert.equal(result.calls.api, 1);
  assert.match(result.error?.message || '', /PRF/);
  assert.equal(result.calls.save, 0);
});

test('a different cache binding cannot use the startup config', async () => {
  const result = await run({ badBinding: true });
  assert.match(result.error?.message || '', /暗号鍵を再確認/);
  assert.equal(result.state.crypto.adminPrivateKey, undefined);
  assert.equal(result.calls.save, 0);
});

test('a changed config rejects a cache from another startup', async () => {
  const result = await run({ otherContext: true, changedConfig: true });
  assert.equal(result.calls.api, 1);
  assert.match(result.error?.message || '', /暗号鍵を再確認/);
  assert.equal(result.calls.save, 0);
});

for (const options of [{ invalidSession: true }, { otherContext: true, changeSessionDuringFetch: true }]) {
  test(`session invalidation rejects key adoption: ${JSON.stringify(options)}`, async () => {
    const result = await run(options);
    assert.equal(result.error?.status, 419);
    assert.equal(result.calls.save, 0);
    assert.equal(result.state.crypto.adminPrivateKey, undefined);
    assert.equal(result.state.crypto.folderKeys.size, 0);
  });
}
