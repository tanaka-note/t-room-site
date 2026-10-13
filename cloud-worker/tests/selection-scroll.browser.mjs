import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 740 } : { width: 1280, height: 900 }, hasTouch: mobile });
    const requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/cloud/api/**', route => {
      requests.push(new URL(route.request().url()).pathname);
      return route.fulfill({ json: { fileIds: [], folderIds: [] } });
    });
    await preparePage(page, fixture.origin, 80);
    await page.evaluate(() => {
      const state = __test.state;
      state.files.forEach(file => { file.hasThumbnail = false; file.mediaKind = 'document'; file.mimeType = 'application/octet-stream'; });
      state.query = 'fixture'; state.sort = 'name'; state.sortDirection = 'desc'; state.listMode = true;
      __test.renderItems();
      globalThis.__scrollBefore = { session: state.session, crypto: state.crypto, node: document.querySelector('.file-card[data-file-id="3"]') };
    });
    for (const action of ['clear', 'back']) {
      await page.evaluate(() => {
        __test.scrollAppTo({ top: 0, left: 0, behavior: 'auto' });
        document.querySelector('.file-card[data-file-id="1"] .file-select-button').click();
      });
      await page.evaluate(() => __test.scrollAppTo({ top: 600, left: 0, behavior: 'auto' }));
      const position = await page.evaluate(() => __test.appScrollPosition().y);
      assert.ok(position > 500, 'fixture must have a meaningful scroll range');
      if (action === 'clear') {
        if (mobile) await page.locator('#selection-clear').tap();
        else await page.locator('#selection-clear').click();
      } else await page.goBack();
      await page.waitForFunction(() => !history.state?.selection && !__test.selectedItems().files.length && !__test.state.selectionClearBackPending);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => ({
        position: __test.appScrollPosition().y, query: __test.state.query, sort: __test.state.sort,
        direction: __test.state.sortDirection, listMode: __test.state.listMode,
        retained: __test.state.session === __scrollBefore.session && __test.state.crypto === __scrollBefore.crypto
          && document.querySelector('.file-card[data-file-id="3"]') === __scrollBefore.node
      }));
      assert.ok(Math.abs(result.position - position) <= 2, JSON.stringify({ action, position, result }));
      assert.deepEqual({ ...result, position: undefined }, { position: undefined, query: 'fixture', sort: 'name', direction: 'desc', listMode: true, retained: true });
    }
    assert.equal(requests.some(path => path.endsWith('/items')), false, 'selection dismissal must not reload the listing');
    assert.deepEqual(errors, []);
    console.log('PASS selection clear/back retains the position reached during selection and existing listing state', name, mobile ? 'touch' : 'desktop');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
