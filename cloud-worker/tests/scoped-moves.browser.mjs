import assert from 'node:assert/strict';
import {engines, startUIFixture, preparePage} from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({headless: true, ...launch});
  try { for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? {viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true} : {});
    const page = await context.newPage(), errors = [], patches = [];
    page.on('pageerror', error => errors.push(error.message));
    let records = [], breadcrumbs = [], deny = false;
    await page.route('**/cloud/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/move-destinations')) {
        assert.equal(url.searchParams.has('scopeRootId'), false, 'member picker does not narrow its scope to the current root');
        await route.fulfill({json: {folders: records}});
      } else if (route.request().method() === 'PATCH') {
        patches.push({path: url.pathname, body: route.request().postDataJSON()});
        await route.fulfill({status: deny ? 401 : 200, json: deny ? {error: 'Synthetic revoked session'} : {ok: true}});
      } else if (url.pathname.endsWith('/items')) {
        const index = breadcrumbs.findIndex(folder => folder.id === Number(url.searchParams.get('folderId')));
        const path = Number(url.searchParams.get('folderId')) === 201 ? [{id:201,parentId:9}] : breadcrumbs.slice(0, index + 1);
        await route.fulfill({json: {folders: [], files: [], breadcrumbs: path, nextFileOffset: null, nextFolderOffset: null}});
      } else await route.fulfill({json: {}});
    });
    try {
      await preparePage(page, fixture.origin, 0);
      const data = await page.evaluate(async () => {
        const state = __test.state;
        state.session = {role: 'member', authMethod: 'passkey', identityId: 'local-member', serviceAccountId: 'folder-member',
          serviceLinkId: 'atsushi', rootFolderId: 7, sessionCacheId: 'local-session', canEditFiles: true, canEditFolders: true,
          folderScopes: [{serviceLinkId: 'atsushi', rootFolderId: 7}, {serviceLinkId: 'nas', rootFolderId: 101}]};
        const key = () => crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
        const sourceKey = await key(), nasKey = await key(), childKey = await key(), deepKey = await key(), movingKey = await key();
        state.crypto.folderKeys = new Map([[7, sourceKey], [101, nasKey], [201, movingKey]]);
        const roots = [{id: 7, parentId: null, name: 'Atsushi'}, {id: 8, parentId: 7, name: 'Videos'}, {id: 9, parentId: 8, name: 'Source'}, {id: 101, parentId: null, name: 'NAS'}];
        const child = {id: 102, parentId: 101, name: 'Child', cryptoVersion: 1, isProtected: false, ...await TRoomCrypto.rewrapFolderForParent(childKey, nasKey)};
        const deep = {id: 103, parentId: 102, name: 'Deep', cryptoVersion: 1, isProtected: false, ...await TRoomCrypto.rewrapFolderForParent(deepKey, childKey)};
        const file = await TRoomCrypto.createFilePackage({name: 'local.mp4', type: 'video/mp4', size: 5, lastModified: 1}, sourceKey, 'video');
        globalThis.__movingFile = {id: 301, folderId: 9, name: 'local.mp4', fileKey: file.fileKey, cryptoVersion: 1, ...file.payload};
        globalThis.__movingFolder = {id: 201, parentId: 9, name: 'Moving', isProtected: false, cryptoVersion: 1};
        globalThis.__moveWitness = {deepKey, movingKey, fileKey: file.fileKey};
        state.folderId = 9; state.breadcrumbs = roots.slice(0, 3); state.files = [__movingFile]; state.folders = [__movingFolder];
        __test.rememberSelectedRecord('file', __movingFile);
        globalThis.TCloudDisplayCache = {...TCloudDisplayCache, supported: () => false};
        return {records: [...roots, child, deep, __movingFolder, {id: 202, parentId: 201, name: 'Excluded descendant'}], breadcrumbs: [roots[3], child, deep]};
      });
      records = data.records; breadcrumbs = data.breadcrumbs;
      await page.evaluate(() => openMoveDialog());
      assert.equal(await page.locator('#move-current-location').innerText(), 'Source');
      assert.deepEqual(await page.locator('#move-breadcrumbs button').allTextContents(), ['利用できるフォルダ', 'Atsushi', 'Videos', 'Source']);
      await page.locator('#move-submit').click();
      assert.match(await page.locator('#move-error').innerText(), /同じ場所/);
      assert.equal(patches.length, 0);
      await page.locator('#move-picker-up').click();
      assert.equal(await page.locator('#move-current-location').innerText(), 'Videos');
      await page.locator('#move-breadcrumbs button[data-folder-id="root"]').click();
      assert.deepEqual(await page.locator('#move-folder-list button').allTextContents(), ['Atsushi', 'NAS']);
      await page.locator('#move-submit').click();
      assert.match(await page.locator('#move-error').innerText(), /移動先フォルダを選択/);
      for (const id of [101, 102, 103]) await page.locator(`#move-folder-list button[data-folder-id="${id}"]`).click();
      await page.locator('#move-submit').click();
      await page.waitForFunction(() => !document.querySelector('#move-dialog').open);
      assert.equal(patches.length, 1);
      assert.equal(patches[0].body.folderId, 103);
      assert.deepEqual(Object.keys(patches[0].body).sort(), ['expectedFolderId', 'fileKeyIv', 'folderId', 'wrappedFileKey']);
      assert.equal(await page.evaluate(async wrapped => {
        const key = await TRoomCrypto.unlockFileKey(wrapped, __moveWitness.deepKey);
        const bytes = await crypto.subtle.exportKey('raw', key);
        const expected = await crypto.subtle.exportKey('raw', __moveWitness.fileKey);
        return new Uint8Array(bytes).toString() === new Uint8Array(expected).toString();
      }, patches[0].body), true, 'unvisited deep path is unlocked in parent-first order');

      // A child folder starts at its parent and excludes itself and descendants.
      await page.evaluate(() => {
        clearSelectedRecords(); state.folders = [__movingFolder]; rememberSelectedRecord('folder', __movingFolder);
      });
      await page.evaluate(() => openMoveDialog());
      assert.equal(await page.locator('#move-current-location').innerText(), 'Source');
      assert.equal(await page.locator('#move-folder-list [data-folder-id="201"], #move-folder-list [data-folder-id="202"]').count(), 0);
      await page.locator('#move-breadcrumbs button[data-folder-id="root"]').click();
      await page.locator('#move-submit').click();
      assert.match(await page.locator('#move-error').innerText(), /移動先フォルダを選択/);
      await page.locator('#move-folder-list button[data-folder-id="101"]').click();
      deny = true;
      await page.locator('#move-submit').click();
      await page.waitForFunction(() => document.querySelector('#move-error').textContent.includes('Synthetic revoked session'));
      assert.equal(await page.locator('#move-dialog').evaluate(dialog => dialog.open), true);
      assert.equal(await page.locator('#move-submit').isEnabled(), true);
      deny = false;
      await page.locator('#move-submit').click();
      await page.waitForFunction(() => !document.querySelector('#move-dialog').open);
      assert.equal(patches.at(-1).body.parentId, 101);
      assert.equal(patches.at(-1).body.passwordAction, 'keep');
      assert.deepEqual(errors, []);
      console.log('PASS scoped move picker', name, {mobile, origin: true, navigation: true, encryptedFile: true, folder: true, denial: true});
    } finally { await context.close(); }
  }} finally { await browser.close(); }
}} finally { await fixture.close(); }
