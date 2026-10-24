import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) for (const mode of ['admin', 'member', 'config-changed', 'cache-miss', 'signed-out']) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
    const errors = [], calls = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await preparePage(page, fixture.origin, 0);
      // Real non-extractable RSA keys, delegated folder envelopes and IndexedDB.
      // No WebAuthn prompt or production API is used in this local fixture.
      const wire = await page.evaluate(async mode => {
        TCloudSession.bind = () => {};
        TCloudSession.isBlocked = () => false;
        bindEvents = () => {};
        restoreInstalledAppPortrait = async () => {};
        scheduleUsageLoad = () => {};
        scheduleLegacyFolderMigration = () => {};
        reportCompletedAppUpdate = () => {};
        globalThis.__authenticationCalls = 0;
        globalThis.TRoomPasskeys = { authenticate: async () => {
          __authenticationCalls++; throw new Error('Synthetic PRF fallback');
        } };
        const member = mode === 'member';
        const session = { authenticated: true, authMethod: 'passkey', sessionCacheId: 'startup-fixture',
          loginId: 'fixture', credentialSalt: 'fixture', accountName: 'Synthetic account',
          role: member ? 'member' : 'admin', serviceAccountId: member ? 'folder-member' : 'admin',
          identityId: 'fixture-identity', credentialId: 'fixture-credential', serviceLinkId: 'fixture-link',
          sessionVersion: '5', passkeySessionEpoch: 1, expiresAt: Math.floor(Date.now() / 1000) + 43200,
          ...(member ? { rootFolderId: 7, folderScopes: [{ serviceLinkId: 'fixture-link', rootFolderId: 7 }] } : {}) };
        const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
        const config = { initialized: true, cryptoVersion: 1, createdAt: '2026-10-01',
          publicKeyJwk: await crypto.subtle.exportKey('jwk', keys.publicKey) };
        __test.state.session = session;
        const envelopes = member ? [{ serviceLinkId: 'fixture-link', rootFolderId: 7,
          wrappedKey: await TRoomCrypto.wrapFolderKeyForIdentity(__thumb.key, config.publicKeyJwk) }] : null;
        if (mode !== 'cache-miss') await saveCachedPasskeyKeys(session, config, keys.privateKey, envelopes);
        const saved = await loadCachedPasskeyKeys(session, config);
        if (Boolean(saved) !== (mode !== 'cache-miss')) throw new Error('Invalid cache fixture');
        __test.state.historyReady = false;
        history.replaceState(null, '', location.href);
        return { session, config };
      }, mode);
      if (mode === 'config-changed') wire.config.createdAt = '2026-10-02';
      await page.route('**/cloud/api/**', async route => {
        const path = new URL(route.request().url()).pathname.slice('/cloud/api'.length);
        calls.push(path);
        const json = path === '/session' ? (mode === 'signed-out' ? { authenticated: false } : wire.session)
          : path === '/crypto-config' ? wire.config
          : path === '/items' ? { folders: [{ id: 7, name: 'Allowed folder', cryptoVersion: 0, isUnlocked: true }],
            files: [], breadcrumbs: [], nextFolderOffset: null, nextFileOffset: null } : {};
        await route.fulfill({ json });
      });
      const result = await page.evaluate(async () => {
        await __test.initialize();
        return { app: !document.querySelector('#app-view').hidden,
          login: !document.querySelector('#login-view').hidden, authenticate: __authenticationCalls,
          folderKey: __test.state.crypto.folderKeys.has(7), folders: __test.state.folders.map(folder => folder.id) };
      });
      if (mode === 'admin' || mode === 'member') {
        assert.deepEqual(calls, ['/session', '/crypto-config', '/items']);
        assert.equal(result.app, true); assert.equal(result.authenticate, 0);
        assert.deepEqual(result.folders, [7]);
        if (mode === 'member') assert.equal(result.folderKey, true);
      } else if (mode === 'signed-out') {
        assert.deepEqual(calls, ['/session']); assert.equal(result.app, false);
        assert.equal(result.login, true); assert.equal(result.authenticate, 0);
      } else {
        assert.deepEqual(calls, ['/session', '/crypto-config', '/logout']);
        assert.equal(result.app, false); assert.equal(result.login, true); assert.equal(result.authenticate, 1);
      }
      assert.deepEqual(errors, []);
      console.log('PASS startup config', name, mobile ? 'touch' : 'desktop', mode);
    } finally { await page.close(); }
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
