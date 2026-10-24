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

async function verifyNavigationBoundaries(page) {
  await page.unroute('**/cloud/api/**');
  let status = 200, continuationStatus = 200, offline = false, delay = 0, mixed = false;
  const requests = [];
  await page.route('**/cloud/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
    requests.push(url.search);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (offline) { await route.abort('internetdisconnected'); return; }
    const code = url.searchParams.has('continuation') ? continuationStatus : status;
    if (code !== 200) { await route.fulfill({ status: code, json: { error: 'Fixture denied' } }); return; }
    const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('pageSize') || 32);
    const folderId = Number(url.searchParams.get('folderId'));
    const count = folderId === 8 ? 0 : 500;
    await route.fulfill({ json: { folders: url.searchParams.has('filesOnly') ? [] : Array.from({ length: Math.max(0, Math.min(size, count - offset)) }, (_, i) => ({
      id: offset + i + 1, name: 'Folder ' + String(offset + i + 1).padStart(3, '0'), cryptoVersion: 0, isUnlocked: true
    })), files: !mixed || url.searchParams.has('foldersOnly') ? [] : Array.from({ length: Math.max(0, Math.min(size, count - offset)) }, (_, i) => ({
      id: 1000 + offset + i, folderId, name: 'File ' + (offset + i), cryptoVersion: 0, mediaKind: 'document', mimeType: 'text/plain'
    })), breadcrumbs: [], nextFolderOffset: offset + size < count ? offset + size : null,
      nextFileOffset: mixed && offset + size < count ? offset + size : null } });
  });
  // A successful response must commit while IDB is still blocked, with no late overwrite.
  await page.evaluate(() => {
    __test.state.crypto.folderKeys.set(7, __thumb.key);
    __test.state.crypto.folderKeys.set(8, __thumb.key);
    globalThis.__originalCache = TCloudDisplayCache;
    globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, supported: () => true,
      getListing: () => new Promise(resolve => { globalThis.__finishCache = () => resolve({ folders: [{ id: 9999, name: 'Stale cache', cryptoVersion: 0 }], files: [] }); }) };
    globalThis.__pendingNavigation = navigateToFolder(8, 'Empty');
  });
  await ready(page);
  assert.equal((await page.evaluate(() => __pendingNavigation)).ok, true);
  await page.evaluate(() => __finishCache()); await frames(page);
  assert.equal(await page.locator('.folder-card, .file-card').count(), 0, 'late cache cannot replace a successful empty response');
  status = 403;
  await page.evaluate(() => { globalThis.__pendingNavigation = navigateToFolder(7, 'Denied with slow IDB'); });
  await ready(page);
  assert.equal((await page.evaluate(() => __pendingNavigation)).ok, false);
  await page.evaluate(() => __finishCache()); await frames(page);
  assert.equal(await page.locator('.folder-card, .file-card').count(), 0, 'a rejection is handled before delayed IDB settles');
  // Cached data must stay behind the navigation barrier until the API verifies access.
  await page.evaluate(() => {
    globalThis.TCloudDisplayCache = { ...__originalCache, supported: () => true, getListing: async () => ({
      folders: [{ id: 9999, name: 'Unverified cache', cryptoVersion: 0 }], files: []
    }) };
  });
  delay = 35;
  for (const code of [401, 403, 404, 419, 423]) {
    status = code;
    const pending = page.evaluate(() => navigateToFolder(7, 'Denied'));
    await page.waitForFunction(() => document.querySelector('.workspace').inert);
    await frames(page);
    assert.equal(await page.locator('[data-folder-id="9999"]').count(), 0, 'never paint unverified cached records');
    assert.equal((await pending).ok, false);
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0, 'denial clears listing: ' + code);
  }
  status = 200; delay = 0;
  // A denied continuation must not commit a partial restored list.
  for (const code of [401, 403, 404, 419, 423]) {
    continuationStatus = code;
    const result = await page.evaluate(() => navigateToFolder(7, 'Denied continuation', {
      restoreEntry: { loadedFolderCount: 160, renderLimit: 160, view: 'all', sort: 'name', sortDirection: 'asc' }
    }));
    assert.equal(result.ok, false, 'continuation denial: ' + code);
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0);
  }
  continuationStatus = 200;
  // Existing offline fallback remains available, but a locked member cannot read it.
  offline = true;
  await page.evaluate(() => { globalThis.__fixtureFetch = TCloudSession.fetch; TCloudSession.fetch = __realSessionGuard.fetch; });
  assert.equal((await page.evaluate(() => navigateToFolder(7, 'Offline'))).ok, true);
  assert.equal(await page.locator('[data-folder-id="9999"]').count(), 1);
  await page.evaluate(() => {
    __test.state.session = { role: 'member', serviceAccountId: 'folder-member', serviceLinkId: 'fixture', rootFolderId: 7, sessionCacheId: 'member' };
    __test.state.crypto.folderKeys.clear();
  });
  assert.equal((await page.evaluate(() => navigateToFolder(7, 'Locked'))).ok, false);
  assert.equal(await page.locator('.folder-card, .file-card').count(), 0);
  offline = false;
  await page.evaluate(() => { TCloudSession.fetch = __fixtureFetch; });
  await page.evaluate(() => { __test.releaseSessionState(); __test.prepare(0); globalThis.TCloudDisplayCache = { ...__originalCache, supported: () => false }; });
  // Restore a partial loaded range exactly, then append a normal 64-item page.
  requests.length = 0;
  await page.evaluate(() => {
    globalThis.__idleWaits = 0; globalThis.__originalIdle = window.requestIdleCallback;
    if (__originalIdle) window.requestIdleCallback = (...args) => { __idleWaits++; return __originalIdle(...args); };
  });
  await page.evaluate(() => navigateToFolder(7, 'Range', { restoreEntry: {
    loadedFolderCount: 160, renderLimit: 160, listMode: true, sort: 'name', sortDirection: 'asc', view: 'all'
  } }));
  assert.equal(await page.evaluate(() => __test.state.folders.length), 160);
  assert.equal(await page.evaluate(() => __idleWaits), 0, 'foreground restoration never waits for idle');
  assert.ok(requests.some(query => new URLSearchParams(query).get('pageSize') === '128'), 'cap restoration at the saved range');
  await page.evaluate(() => document.querySelector('[data-folder-id="90"]').scrollIntoView({ block: 'center' }));
  await frames(page);
  const anchor = await page.locator('[data-folder-id="90"]').evaluate(card => card.getBoundingClientRect().top);
  await page.evaluate(() => __test.loadNextItemPage()); await frames(page);
  assert.ok(Math.abs(await page.locator('[data-folder-id="90"]').evaluate(card => card.getBoundingClientRect().top) - anchor) <= 2, 'normal append and browser scroll anchoring retain the visible card');
  assert.equal(new URLSearchParams(requests.at(-1)).get('pageSize'), '64', 'normal infinite scroll retains its page size');
  await page.evaluate(() => { if (__originalIdle) window.requestIdleCallback = __originalIdle; });
  // Grid mode and its anchor also survive a hierarchy round trip.
  await page.evaluate(() => {
    __test.state.listMode = false; __test.renderItems();
    document.querySelector('[data-folder-id="90"]').scrollIntoView({ block: 'center' });
  });
  await frames(page);
  const gridAnchor = await page.locator('[data-folder-id="90"]').evaluate(card => card.getBoundingClientRect().top);
  await page.evaluate(() => openFolder(__test.state.folders.find(folder => folder.id === 90)));
  await traverse(page, 'back'); await ready(page); await frames(page);
  assert.equal(await page.evaluate(() => __test.state.listMode), false);
  assert.ok(Math.abs(await page.locator('[data-folder-id="90"]').evaluate(card => card.getBoundingClientRect().top) - gridAnchor) <= 2, 'grid mode restores the anchor');
  mixed = true;
  await page.evaluate(() => navigateToFolder(7, 'Mixed range', { restoreEntry: {
    loadedFolderCount: 160, loadedFileCount: 500, renderLimit: 660, view: 'all', listMode: true
  } }));
  assert.deepEqual(await page.evaluate(() => [__test.state.folders.length, __test.state.files.length, __test.state.itemNextFolderOffset]),
    [160, 500, 160], 'stop each stream at its saved range while retaining the remaining continuation');
  await page.evaluate(() => document.querySelector('[data-file-id="1100"]').scrollIntoView({ block: 'center' }));
  await frames(page);
  const fileAnchor = await page.locator('[data-file-id="1100"]').evaluate(card => card.getBoundingClientRect().top);
  await page.evaluate(() => __test.loadNextItemPage()); await frames(page);
  assert.ok(Math.abs(await page.locator('[data-file-id="1100"]').evaluate(card => card.getBoundingClientRect().top) - fileAnchor) <= 2,
    'loading the remaining folder prefix retains the visible file position');
  mixed = false;
  // Interrupt restoration with a new navigation and with session/account replacement.
  delay = 60;
  for (const switchAccount of [false, true]) {
    await page.evaluate(() => { globalThis.__interrupted = navigateToFolder(7, 'Old', { restoreEntry: { loadedFolderCount: 500, view: 'all' } }); });
    await page.waitForFunction(() => __test.state.itemPageLoading);
    await page.evaluate(switchAccount => {
      if (switchAccount) { __test.releaseSessionState(); __test.prepare(0); __test.state.session = { ...__test.state.session, serviceAccountId: 'other', sessionCacheId: 'other' }; }
      return navigateToFolder(8, 'New');
    }, switchAccount);
    await page.evaluate(() => __interrupted); await frames(page);
    assert.equal(await page.evaluate(() => __test.state.folderId), 8);
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0);
    assert.equal(await page.evaluate(() => __test.appScrollPosition().y), 0);
  }
}
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
    await verifyNavigationBoundaries(page);
    assert.deepEqual(errors, []);
    console.log('PASS', name, mobile ? 'touch' : 'desktop', cached ? 'cached' : 'uncached', 'atomic folder Back/Forward, range, search, sort, hierarchy, rapid navigation and denied access');
    await page.close();
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }

await import('./folder-navigation-review.browser.mjs');
await import('./startup-security.browser.mjs');
await import('./startup-config-reuse.browser.mjs');
