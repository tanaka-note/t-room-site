import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 740 } : { width: 1280, height: 900 }, hasTouch: mobile });
    const gate = deferred(), ready = deferred(), writes = [], requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/cloud/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname; requests.push(path);
      if (request.method() === 'DELETE') {
        writes.push({ path, body: request.postData() }); if (writes.length === 3) ready.resolve();
        await gate.promise;
        await route.fulfill(path.endsWith('/files/2') ? { status: 500, json: { error: 'fixture failure' } } : { json: { deleted: 3 } });
      } else await route.fulfill({ json: { fileIds: [], folderIds: [], folders: [], totalBytes: 4000, totalFiles: 40 } });
    });
    await preparePage(page, fixture.origin, 40);
    await page.evaluate(() => {
      const state = __test.state;
      state.folderId = 8; state.breadcrumbs = [{ id: 8, name: 'fixture root', isUnlocked: true }]; state.crypto.folderKeys.set(8, __thumb.key);
      state.files.forEach(file => { file.hasThumbnail = false; file.folderId = 8; file.mediaKind = 'document'; file.mimeType = 'application/octet-stream'; });
      state.folders = [{ id: 9, parentId: 8, name: 'fixture folder', cryptoVersion: 1, isUnlocked: true }]; state.crypto.folderKeys.set(9, __thumb.key);
      state.session.canEditFolders = true; state.query = 'fixture'; state.sort = 'name'; state.sortDirection = 'desc'; state.listMode = true; state.itemRenderLimit = 100;
      state.folderSummary = { fileCount: 40, folderCount: 1, totalFileCount: 40, totalSizeBytes: 4000 };
      __test.renderItems();
      history.replaceState({ tcloud: true, folderId: 8, folderName: 'fixture root', previewId: null }, '', location.href);
      globalThis.__deleteBefore = { session: state.session, crypto: state.crypto, key: state.crypto.folderKeys.get(8),
        upload: state.uploadAbort = new AbortController(), download: state.downloadAbort = new AbortController(), preview: state.previewPlayer = {},
        node: document.querySelector('.file-card[data-file-id="3"]') };
    });
    const click = async selector => mobile ? page.locator(selector).tap() : page.locator(selector).click();
    await click('.file-card[data-file-id="1"] .file-select-button');
    // Denied permissions and cancelled confirmation must leave the list untouched.
    await page.evaluate(async () => { const state = __test.state; state.session.canDelete = false; await __test.deleteSelectedItems(); state.session.canDelete = true; });
    assert.equal(writes.length, 0);
    page.once('dialog', dialog => dialog.dismiss()); await click('#selection-delete'); assert.equal(writes.length, 0);
    await click('.file-card[data-file-id="2"] .file-select-button'); await click('.folder-card[data-folder-id="9"] .folder-select-button');
    await page.evaluate(() => __test.scrollAppTo({ top: 400, left: 0, behavior: 'auto' }));
    const position = await page.evaluate(() => __test.appScrollPosition().y);
    page.once('dialog', dialog => dialog.accept());
    // Keep the selected delete button in view without Playwright changing scroll.
    await page.evaluate(() => document.querySelector('#selection-delete').click());
    let timer; try { await Promise.race([ready.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Deletion requests did not start')), 5000); })]); } finally { clearTimeout(timer); }
    assert.equal(await page.locator('#selection-delete').isDisabled(), true);
    assert.equal(await page.locator('#selection-delete').textContent(), '削除中 0 / 3');
    await page.evaluate(() => __test.rememberSelectedRecord('file', __test.state.files.find(file => file.id === 5)));
    gate.resolve();
    await page.waitForFunction(() => !__test.state.files.some(file => file.id === 1) && !__test.state.folders.length && !__test.state.selectionClearBackPending);
    const result = await page.evaluate(() => {
      const state = __test.state, before = __deleteBefore;
      return { remaining: state.files.filter(file => [1, 2, 5].includes(file.id)).map(file => file.id), query: state.query, sort: state.sort, direction: state.sortDirection, listMode: state.listMode,
        position: __test.appScrollPosition().y, selected: __test.selectedItems().files.length + __test.selectedItems().folders.length,
        node: document.querySelector('.file-card[data-file-id="3"]') === before.node,
        authority: state.session === before.session && state.crypto === before.crypto && state.crypto.folderKeys.get(8) === before.key,
        transfers: state.uploadAbort === before.upload && state.downloadAbort === before.download && !before.upload.signal.aborted && !before.download.signal.aborted,
        preview: state.previewPlayer === before.preview, notice: document.querySelector('#notice').textContent };
    });
    assert.deepEqual(writes.map(write => write.path).sort(), ['/cloud/api/files/1', '/cloud/api/files/2', '/cloud/api/folders/9']);
    assert.ok(writes.every(write => write.body === '{}'));
    assert.deepEqual(result.remaining, [2, 5]); assert.equal(result.query, 'fixture'); assert.equal(result.sort, 'name'); assert.equal(result.direction, 'desc'); assert.equal(result.listMode, true);
    assert.ok(Math.abs(result.position - position) <= 2, JSON.stringify({ position, result }));
    assert.equal(result.selected, 0); assert.ok(result.node && result.authority && result.transfers && result.preview);
    assert.equal(result.notice, '2件を処理しました。削除できなかった1件：fixture 1');
    assert.equal(requests.some(path => path.endsWith('/items')), false); assert.deepEqual(errors, []);
    console.log('PASS bulk delete permission/cancel, captured targets, partial failure, retained cards/search/sort/scroll/history and unrelated state', name, mobile ? 'touch' : 'desktop');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
