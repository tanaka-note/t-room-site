import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ready = page => page.waitForFunction(() => !document.querySelector('.workspace').inert);
// History traversal is asynchronous; an idle workspace before popstate is not completion.
const traverse = (page, direction) => page.evaluate(direction => new Promise(resolve => {
  window.addEventListener('popstate', () => resolve(), { once: true });
  history[direction]();
}), direction);
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) for (const cached of [false, true]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let delay = 50;
    await page.route('**/cloud/api/**', async route => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname.endsWith('/items')) {
        await new Promise(resolve => setTimeout(resolve, delay));
        const child = Number(url.searchParams.get('folderId') || 0), count = child ? 100 : 160;
        if (child === 777) { await route.fulfill({ status: 403, json: { error: 'Access denied' } }); return; }
        const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('pageSize') || 32);
        data = {
          folders: Array.from({ length: Math.max(0, Math.min(size, count - offset)) }, (_, i) => ({
            id: (child ? 1000 : 0) + offset + i + 1, parentId: child || null,
            name: 'Folder ' + String(offset + i + 1).padStart(3, '0'),
            cryptoVersion: 0, isUnlocked: true, fileCount: 0, folderCount: 0
          })), files: [], nextFolderOffset: offset + size < count ? offset + size : null, nextFileOffset: null,
          breadcrumbs: child ? [{ id: child, name: 'Child', cryptoVersion: 0, isUnlocked: true }] : []
        };
      } else if (url.pathname.endsWith('/favorites/status')) data = { fileIds: [], folderIds: [] };
      else if (url.pathname.endsWith('/conflicts')) data = { files: [], folders: [], groups: [] };
      await route.fulfill({ json: data });
    });
    await preparePage(page, fixture.origin, 0);
    await page.evaluate(cached => {
      if (!cached) globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, supported: () => false };
      return navigateToFolder(null, 'フォルダ');
    }, cached);
    await page.evaluate(async () => {
      await __test.loadNextItemPage(); await __test.loadNextItemPage();
      __test.state.listMode = true;
      __test.state.sort = 'name'; __test.state.sortDirection = 'desc'; __test.state.sortUsesTypeDefaults = false;
      __test.state.folders = finalizeHydratedFolders(__test.state.folders);
      __test.renderItems();
      document.querySelector('.folder-card[data-folder-id="90"]').scrollIntoView({ block: 'center' });
    });
    await frames(page);
    const original = await page.evaluate(() => __test.appScrollPosition().y);
    const originalAnchor = await page.locator('.folder-card[data-folder-id="90"]').evaluate(card => card.getBoundingClientRect().top);
    assert.ok(original > 1000);
    if (cached) await page.waitForTimeout(150);
    await page.evaluate(() => openFolder(__test.state.folders.find(folder => folder.id === 90)));
    await frames(page);
    assert.equal(await page.evaluate(() => __test.appScrollPosition().y), 0, 'new folders start at the top');
    await page.evaluate(() => {
      __test.scrollAppTo({ top: 1100, behavior: 'auto' });
      globalThis.__navigationSamples = []; globalThis.__sampleNavigation = true;
      const sample = () => {
        if (!__sampleNavigation) return;
        __navigationSamples.push({ y: __test.appScrollPosition().y,
          first: document.querySelector('.folder-card')?.dataset.folderId,
          title: document.querySelector('#view-title').textContent });
        requestAnimationFrame(sample);
      };
      sample();
    });
    await traverse(page, 'back');
    await ready(page); await frames(page);
    const back = await page.evaluate(() => {
      __sampleNavigation = false;
      return { samples: __navigationSamples, y: __test.appScrollPosition().y, mode: __test.state.listMode,
        sort: __test.state.sort, direction: __test.state.sortDirection, folders: __test.state.folders.length };
    });
    assert.ok(Math.abs(back.y - original) <= 2, JSON.stringify(back));
    assert.equal(back.mode, true); assert.equal(back.sort, 'name'); assert.equal(back.direction, 'desc');
    assert.equal(back.folders, 160, 'restore the previously loaded range, not just the clicked item');
    assert.ok(Math.abs(await page.locator('.folder-card[data-folder-id="90"]').evaluate(card => card.getBoundingClientRect().top) - originalAnchor) <= 2, 'the opened folder retains its position within the viewport');
    const parentFrames = back.samples.filter(sample => sample.title === 'フォルダ');
    assert.ok(parentFrames.length > 0);
    assert.ok(parentFrames.every(sample => Math.abs(sample.y - original) <= 2), 'never paint the destination at a partial-list position: ' + JSON.stringify(parentFrames));
    await traverse(page, 'forward'); await ready(page); await frames(page);
    assert.ok(Math.abs(await page.evaluate(() => __test.appScrollPosition().y) - 1100) <= 2, 'Forward restores the position reached before Back');
    delay = 120;
    await traverse(page, 'back');
    await page.waitForFunction(() => document.querySelector('.workspace').inert);
    await traverse(page, 'forward'); await ready(page); await frames(page);
    assert.equal(await page.evaluate(() => __test.state.folderId), 90);
    assert.ok(Math.abs(await page.evaluate(() => __test.appScrollPosition().y) - 1100) <= 2);
    delay = 0;
    await page.evaluate(() => document.querySelector('#breadcrumbs button').click());
    await ready(page); await frames(page);
    assert.ok(Math.abs(await page.evaluate(() => __test.appScrollPosition().y) - original) <= 2, 'hierarchy links retain the parent position');
    await page.evaluate(() => openFolder(__test.state.folders.find(folder => folder.id === 91)));
    await page.waitForTimeout(120); await frames(page);
    assert.equal(await page.evaluate(() => __test.appScrollPosition().y), 0, 'an old restoration cannot move a newly opened folder');
    await page.evaluate(() => navigateToFolder(null, 'フォルダ'));
    await page.evaluate(() => { __test.state.query = 'Folder 0'; return __test.loadItems(); });
    await page.waitForFunction(() => !__test.state.progressiveItemsLoading && !__test.state.itemPageLoading);
    await page.evaluate(() => document.querySelector('.folder-card[data-folder-id="90"]').scrollIntoView({ block: 'center' }));
    await frames(page);
    const searchPosition = await page.evaluate(() => __test.appScrollPosition().y);
    await page.evaluate(() => openFolder(__test.state.folders.find(folder => folder.id === 90)));
    await traverse(page, 'back'); await ready(page); await frames(page);
    assert.equal(await page.evaluate(() => __test.state.query), 'Folder 0');
    assert.ok(Math.abs(await page.evaluate(() => __test.appScrollPosition().y) - searchPosition) <= 2, 'search results retain their position');
    const denied = await page.evaluate(() => navigateToFolder(777, 'Denied'));
    assert.equal(denied.ok, false);
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0, 'a failed navigation cannot present the preceding folder as its contents');
    assert.equal(await page.evaluate(() => document.querySelector('.workspace').inert), false);
    assert.deepEqual(errors, []);
    console.log('PASS', name, mobile ? 'touch' : 'desktop', cached ? 'cached' : 'uncached', 'atomic folder Back/Forward, range, search, sort, hierarchy, rapid navigation and denied access');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
