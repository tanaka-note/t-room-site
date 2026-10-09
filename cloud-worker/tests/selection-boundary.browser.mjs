import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 740 } : { width: 1280, height: 900 }, hasTouch: mobile });
    const errors = [], requests = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/cloud/api/**', async route => {
      requests.push(new URL(route.request().url()).pathname);
      await route.fulfill({ json: { fileIds: [], folderIds: [] } });
    });
    await preparePage(page, fixture.origin, 3);
    await page.evaluate(() => {
      const state = __test.state;
      state.files.forEach(file => { file.hasThumbnail = false; file.folderId = 8; });
      state.files[2].trashed = true;
      state.folders = [{ id: 8, name: '選択フォルダ', cryptoVersion: 1, isUnlocked: true }];
      state.session.canEditFolders = true; state.crypto.folderKeys.set(8, __thumb.key); state.itemRenderLimit = 100;
      __test.renderItems();
      // A loaded record without a rendered card must not be selected by "all".
      state.files.push({ id: 99, name: 'not rendered', cryptoVersion: 1, fileKey: __thumb.key });
      globalThis.__selectionBefore = { session: state.session, crypto: state.crypto, key: state.crypto.folderKeys.get(8),
        upload: state.uploadAbort = new AbortController(), download: state.downloadAbort = new AbortController(),
        preview: state.previewPlayer = {}, nodes: [...document.querySelector('#content-grid').children], historyLength: history.length };
    });
    const click = async selector => mobile ? page.locator(selector).tap() : page.locator(selector).click();
    await click('.file-card[data-file-id="1"] .file-select-button');
    assert.equal(await page.locator('.file-card[data-file-id="1"] .file-select-button').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#selection-download').isVisible(), true);
    await click('.folder-card[data-folder-id="8"] .folder-select-button');
    assert.equal(await page.locator('#selection-download').isVisible(), false);
    assert.equal(await page.locator('#selection-move').isVisible(), true);
    assert.equal(await page.locator('#selection-delete').isVisible(), true);
    assert.equal(await page.locator('#selection-share').isVisible(), true);
    assert.equal(await page.evaluate(() => history.length - __selectionBefore.historyLength), 1);
    const retained = await page.evaluate(() => {
      globalThis.__capturedSelection = __test.selectedItems(); __test.selectAllVisibleItems();
      const state = __test.state, before = __selectionBefore, selected = __test.selectedItems();
      return { fileIds: selected.files.map(file => file.id), folderIds: selected.folders.map(folder => folder.id),
        session: state.session === before.session, keys: state.crypto === before.crypto && state.crypto.folderKeys.get(8) === before.key,
        transfers: state.uploadAbort === before.upload && state.downloadAbort === before.download && !before.upload.signal.aborted && !before.download.signal.aborted,
        preview: state.previewPlayer === before.preview, nodes: before.nodes.every((node, i) => document.querySelector('#content-grid').children[i] === node) };
    });
    assert.deepEqual(retained, { fileIds: [1, 2], folderIds: [8], session: true, keys: true, transfers: true, preview: true, nodes: true });
    await page.goBack();
    await page.waitForFunction(() => !__test.selectedItems().files.length && !__test.selectedItems().folders.length);
    assert.equal(await page.locator('#content-grid .selected').count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ files: __capturedSelection.files.map(file => file.id), folders: __capturedSelection.folders.map(folder => folder.id) })), { files: [1], folders: [8] });
    await click('.file-card[data-file-id="2"] .file-select-button');
    await click('#selection-clear');
    await page.waitForFunction(() => !history.state?.selection && !__test.state.selectionClearBackPending);
    assert.equal(await page.locator('#selection-bar').isVisible(), false);
    assert.equal(await page.locator('.file-card[data-file-id="2"] .file-select-button').getAttribute('aria-pressed'), 'false');
    assert.equal(requests.some(path => path.endsWith('/items')), false, 'selection/back/clear must not reload the listing');
    await page.evaluate(() => { __test.state.session = { ...__test.state.session, role: 'member', canDelete: false, canEditFiles: false, canEditFolders: false }; });
    await click('.file-card[data-file-id="1"] .file-select-button');
    for (const id of ['selection-delete', 'selection-move', 'selection-share', 'selection-rename']) assert.equal(await page.locator('#' + id).isVisible(), false, id);
    await page.evaluate(() => { __test.clearFileSelection(true, false); __test.releaseSessionState(); });
    assert.deepEqual(await page.evaluate(() => ({ files: __test.selectedItems().files.length, folders: __test.selectedItems().folders.length })), { files: 0, folders: 0 });
    assert.deepEqual(errors, []);
    console.log('PASS selection, mixed toolbar, rendered-only select all, back/clear, captured targets, role gates, unrelated state and logout', name, mobile ? 'touch' : 'desktop');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
