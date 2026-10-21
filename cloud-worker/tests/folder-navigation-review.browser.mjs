import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const idle = page => page.waitForFunction(() => !document.querySelector('.workspace').inert);
// Playwright serializes Error values without custom HTTP status properties.
const navigate = (page, ...args) => page.evaluate(async args => {
  const result = await navigateToFolder(...args);
  return { ...result, error: result.error && { status: result.error.status, message: result.error.message } };
}, args);

async function cacheFailures(page, origin) {
  let status = 200, networkFailure = false;
  await page.route('**/cloud/api/**', async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
    if (networkFailure) { await route.abort('internetdisconnected'); return; }
    await route.fulfill({ status, json: status === 200
      ? { folders: [], files: [], breadcrumbs: [], nextFolderOffset: null, nextFileOffset: null }
      : { error: 'Synthetic API error' } });
  });
  await preparePage(page, origin, 0);
  await page.evaluate(async () => {
    globalThis.__cacheApi = TCloudDisplayCache;
    globalThis.__guardValid = true;
    TCloudSession.check = () => { if (!__guardValid) throw Object.assign(new Error('Expired fixture'), { status: 419 }); };
    globalThis.__cacheDelay = 0; globalThis.__cacheReject = false;
    globalThis.TCloudDisplayCache = { ...__cacheApi, getListing: async (...args) => {
      globalThis.__cacheStarted = true;
      const read = globalThis.__lastCacheRead = { done: false };
      try {
        if (__cacheDelay) await new Promise(resolve => setTimeout(resolve, __cacheDelay));
        if (__cacheReject) throw new Error('Synthetic IDB error');
        return await __cacheApi.getListing(...args);
      } finally { read.done = true; }
    } };
    globalThis.__selectCacheSession = (role = 'admin') => {
      __test.releaseSessionState(); __test.prepare(0); __guardValid = true;
      __test.state.session = role === 'member'
        ? { role, serviceAccountId: 'folder-member', serviceLinkId: 'review-link', rootFolderId: 7, sessionCacheId: 'review-member' }
        : { role, serviceAccountId: role, sessionCacheId: 'review-' + role };
      __test.state.folderId = 7; __test.state.crypto.folderKeys.set(7, __thumb.key);
      __test.state.sort = 'updated'; __test.state.sortDirection = 'desc'; __test.state.sortUsesTypeDefaults = true;
      return { scope: __test.displayCacheScope(), key: displayListingCacheKey(new URLSearchParams({ sort: 'updated-desc', folderId: '7' })) };
    };
    globalThis.__seedCache = async (role = 'admin') => {
      const { scope, key } = __selectCacheSession(role);
      await __cacheApi.putListing(scope, key, { folders: [{ id: 99001, name: 'Authorized cached folder', cryptoVersion: 0 }], files: [], breadcrumbs: [] });
      __cacheStarted = false;
    };
    await __seedCache();
  });

  // Reproduce API errors beating IDB, rather than merely testing a warm cache hit.
  for (const code of [500, 502, 503]) {
    status = code;
    await page.evaluate(async () => { await __seedCache(); __cacheDelay = 90; });
    const result = await navigate(page, 7, 'Fallback');
    assert.equal(result.ok, true, 'HTTP ' + code + ' retains authorized delayed cache');
    assert.equal(result.partial, true); assert.equal(result.error.status, code);
    assert.equal(await page.locator('[data-folder-id="99001"]').count(), 1);
  }
  networkFailure = true;
  await page.evaluate(() => { globalThis.__fixtureFetch = TCloudSession.fetch; TCloudSession.fetch = __realSessionGuard.fetch; });
  assert.equal((await page.evaluate(() => navigateToFolder(7, 'Offline'))).partial, true);
  networkFailure = false;
  await page.evaluate(() => { TCloudSession.fetch = __fixtureFetch; });

  // Success wins without waiting for a 600ms read, whose later result cannot overwrite it.
  status = 200;
  await page.evaluate(() => { __cacheDelay = 600; __cacheStarted = false; globalThis.__completed = false;
    globalThis.__pending = navigateToFolder(7, 'Fresh empty').then(result => { __completed = true; return result; }); });
  await page.waitForFunction(() => __cacheStarted); await idle(page);
  assert.equal((await page.evaluate(() => __pending)).ok, true);
  assert.equal(await page.evaluate(() => __lastCacheRead.done), false, 'successful API commits before the delayed IDB read completes');
  assert.equal(await page.locator('.folder-card, .file-card').count(), 0);
  await page.waitForTimeout(650); await frames(page);
  assert.equal(await page.locator('.folder-card, .file-card').count(), 0, 'late IDB cannot replace an empty successful response');

  for (const cacheDelay of [0, 90]) for (const code of [400, 401, 403, 404, 419, 423, 429]) {
    status = code;
    await page.evaluate(async delay => { await __seedCache(); __cacheDelay = delay; }, cacheDelay);
    const { result, paints } = await page.evaluate(async () => {
      const paints = []; let sampling = true;
      const sample = () => { if (!sampling) return; paints.push(document.querySelectorAll('[data-folder-id="99001"]').length); requestAnimationFrame(sample); }; sample();
      const result = await navigateToFolder(7, 'Denied');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); sampling = false;
      return { result: { ...result, error: { status: result.error?.status } }, paints };
    });
    assert.equal(result.ok, false, 'HTTP ' + code + ' denies both fast and slow caches');
    assert.equal(result.error.status, code);
    assert.ok(paints.every(count => count === 0), 'denied cache never paints, including intermediate frames');
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0);
  }
  status = 503;
  for (const reject of [false, true]) {
    await page.evaluate(async reject => { const { scope } = __selectCacheSession(); await __cacheApi.clearScope(scope);
      __cacheReject = reject; __cacheDelay = 90; }, reject);
    const result = await navigate(page, 7, 'Unavailable');
    assert.equal(result.ok, false); assert.equal(result.error.status, 503);
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0, 'no cache or both failures stay empty');
  }
  await page.evaluate(() => { __cacheReject = false; });
  // An eligible member can use its own unlocked cache; key removal invalidates a pending read.
  for (const role of ['admin', 'subadmin', 'member']) {
    await page.evaluate(role => __seedCache(role), role);
    assert.equal((await page.evaluate(() => navigateToFolder(7, 'Own cache'))).partial, true, role);
  }
  for (const change of ['abort', 'logout', 'account', 'same-account-session', 'expiry', 'key', 'no-session']) {
    await page.evaluate(async () => { await __seedCache('member'); __cacheDelay = 600; __cacheStarted = false;
      globalThis.__pending = navigateToFolder(7, 'Old cache'); });
    await page.waitForFunction(() => __cacheStarted);
    await page.waitForTimeout(30);
    await page.evaluate(change => {
      if (change === 'abort') __test.state.itemLoadController.abort();
      if (change === 'logout') __test.releaseSessionState();
      if (change === 'account') __test.state.session = { ...__test.state.session, serviceAccountId: 'other', sessionCacheId: 'other' };
      if (change === 'same-account-session') __test.state.session = { ...__test.state.session, sessionCacheId: 'new-session' };
      if (change === 'expiry') __guardValid = false;
      if (change === 'key') __test.state.crypto.folderKeys.clear();
      if (change === 'no-session') __test.state.session = null;
    }, change);
    const result = await page.evaluate(() => __pending);
    assert.equal(result.ok, false, change + ' forbids the old cached listing');
    if (change === 'abort' || change === 'logout') {
      assert.equal(result.stale, true);
      assert.equal(await page.evaluate(() => __lastCacheRead.done), false, 'cancellation does not wait for IDB');
    }
    assert.equal(await page.locator('[data-folder-id="99001"]').count(), 0, change);
    await page.waitForTimeout(change === 'abort' ? 650 : 0);
    assert.equal(await page.locator('[data-folder-id="99001"]').count(), 0, 'late cache remains discarded: ' + change);
  }
}

async function originRange(page, origin) {
  let count = 5500, ids = [], failContinuation = 0, delay = 0;
  let folderCount = 0, folderIds = [];
  const calls = [];
  await page.route('**/cloud/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (Number(url.searchParams.get('folderId')) === 8) { await route.fulfill({ json: { folders: [], files: [], breadcrumbs: [] } }); return; }
    const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('pageSize'));
    calls.push({ offset, size, foldersOnly: url.searchParams.has('foldersOnly'), filesOnly: url.searchParams.has('filesOnly') });
    if (failContinuation && url.searchParams.has('continuation')) { await route.fulfill({ status: failContinuation, json: { error: 'Synthetic continuation error' } }); return; }
    const filePage = url.searchParams.has('foldersOnly') ? [] : ids.slice(offset, offset + size);
    const folderPage = url.searchParams.has('filesOnly') ? [] : folderIds.slice(offset, offset + size);
    await route.fulfill({ json: { folders: folderPage.map(id => ({ id, name: 'Folder ' + id, cryptoVersion: 0, isUnlocked: true })),
      files: filePage.map(id => ({ id, folderId: 7, name: 'File ' + String(id).padStart(6, '0'), cryptoVersion: 0, mediaKind: 'document', mimeType: 'text/plain' })),
      breadcrumbs: [], nextFolderOffset: offset + size < folderIds.length ? offset + size : null,
      nextFileOffset: offset + size < ids.length ? offset + size : null } });
  });
  await preparePage(page, origin, 0);
  await page.evaluate(() => { globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, supported: () => false }; });
  const restore = async ({ total, saved, remove = [], add = [], folders = 0, savedFolders = folders ? 160 : 0,
    removeFolders = [], addFolders = [], originType = 'file' }) => {
    count = total; ids = [...add, ...Array.from({ length: count }, (_, i) => i + 1).filter(id => !remove.includes(id))];
    folderCount = folders; calls.length = 0;
    folderIds = [...addFolders, ...Array.from({ length: folderCount }, (_, i) => i + 10000).filter(id => !removeFolders.includes(id))];
    const result = await page.evaluate(async ({ saved, savedFolders, originType }) => {
      await navigateToFolder(8, 'Empty');
      const entry = { tcloud: true, view: 'all', sort: 'updated', sortDirection: 'desc', sortUsesTypeDefaults: true,
        listMode: true, loadedFolderCount: savedFolders, loadedFileCount: saved, renderLimit: Math.max(192, savedFolders + 192),
        originType, originId: originType === 'folder' ? 10089 : 90, originOffsetY: 300, scrollX: 0, scrollY: 2400 };
      globalThis.__restoreSamples = []; globalThis.__sampling = true;
      const sample = () => { if (!__sampling) return; __restoreSamples.push({ title: document.querySelector('#view-title').textContent, y: __test.appScrollPosition().y }); requestAnimationFrame(sample); }; sample();
      const result = await navigateToFolder(7, 'Restored', { restoreEntry: entry });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); __sampling = false;
      return { result, files: __test.state.files.length, folders: __test.state.folders.length,
        next: __test.state.itemNextFileOffset, folderNext: __test.state.itemNextFolderOffset, y: __test.appScrollPosition().y,
        anchor: document.querySelector(originType === 'folder' ? '[data-folder-id="10089"]' : '[data-file-id="90"]')?.getBoundingClientRect().top,
        rootTop: appScrollRoot()?.getBoundingClientRect().top || 0, samples: __restoreSamples };
    }, { saved, savedFolders, originType });
    assert.equal(result.result.ok, true);
    assert.ok(result.samples.filter(sample => sample.title === 'Restored').every(sample => Math.abs(sample.y - result.y) <= 2), 'only the completed range and its position paint');
    return result;
  };
  // Reproduce an absent anchor scanning all 5,500 records beyond a saved 1,056-item range.
  let result = await restore({ total: 5500, saved: 1056, remove: [90] });
  assert.equal(result.files, 1306, 'missing anchor permits only 250 extra records after the saved range');
  assert.equal(calls.length, 7, 'initial + five range pages + one bounded origin search');
  assert.equal(result.next, 1306); assert.ok(Math.abs(result.y - 2400) <= 2, 'missing anchor uses saved coordinates');
  for (const total of [160, 500, 1056]) {
    result = await restore({ total, saved: total });
    assert.equal(result.files, total); assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2, 'existing file anchor: ' + total);
    assert.equal(calls.length, 1 + Math.ceil((total - 32) / 250));
  }
  for (const [total, saved] of [[1056, 1056], [1056, 160], [5500, 160]]) {
    result = await restore({ total, saved, remove: [90] });
    assert.ok(result.files <= saved + 250); assert.ok(Math.abs(result.y - 2400) <= 2);
    assert.ok(calls.length <= 2 + Math.ceil((saved - 32) / 250));
  }
  // A moved-away file has the same absence semantics; nearby reordering still finds the anchor.
  result = await restore({ total: 5500, saved: 160, remove: [90], folders: 500 });
  assert.equal(result.files, 410); assert.equal(result.folders, 160); assert.equal(result.folderNext, 160);
  const beforeNext = result.next;
  await page.evaluate(() => __test.loadNextItemPage());
  assert.ok(calls.slice(-2).every(call => call.size === 64));
  assert.equal(await page.evaluate(() => __test.state.itemNextFileOffset), beforeNext + 64);
  result = await restore({ total: 1056, saved: 160, add: Array.from({ length: 100 }, (_, i) => 20000 + i) });
  assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2, 'anchor displaced into the extra page is retained: ' + JSON.stringify(result));
  result = await restore({ total: 1056, saved: 160, remove: Array.from({ length: 20 }, (_, i) => i + 1) });
  assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2, 'deletions before the anchor retain viewport position');
  result = await restore({ total: 5500, saved: 160, add: Array.from({ length: 500 }, (_, i) => 20000 + i) });
  assert.equal(result.files, 410); assert.ok(Math.abs(result.y - 2400) <= 2, 'far reordering falls back within the same bound');
  result = await restore({ total: 0, saved: 0, folders: 5500, savedFolders: 1056, originType: 'folder' });
  assert.equal(result.folders, 1056); assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2, 'folder anchor is retained');
  result = await restore({ total: 0, saved: 0, folders: 5500, savedFolders: 1056, removeFolders: [10089], originType: 'folder' });
  assert.equal(result.folders, 1306); assert.equal(calls.length, 7); assert.ok(Math.abs(result.y - 2400) <= 2);
  result = await restore({ total: 0, saved: 0, folders: 5500, addFolders: Array.from({ length: 100 }, (_, i) => 20000 + i), originType: 'folder' });
  assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2, 'nearby folder reordering is retained');
  result = await restore({ total: 5500, saved: 160, folders: 100, savedFolders: 160,
    add: Array.from({ length: 100 }, (_, i) => 20000 + i) });
  assert.equal(result.files, 410); assert.equal(result.folders, 100);
  assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2, 'an exhausted shorter stream does not prevent nearby anchor search');
  for (const code of [403, 500]) {
    failContinuation = code;
    const failed = await navigate(page, 7, 'Failure', { restoreEntry: { view: 'all', loadedFileCount: 1056, originType: 'file', originId: 90 } });
    assert.equal(failed.ok, false); assert.equal(failed.error.status, code);
    assert.equal(await page.locator('.folder-card, .file-card').count(), 0);
  }
  failContinuation = 0; delay = 30;
  for (const endSession of [false, true]) {
    await page.evaluate(() => { globalThis.__oldRestore = navigateToFolder(7, 'Old', { restoreEntry: { view: 'all', loadedFileCount: 1056, originType: 'file', originId: 90 } }); });
    await page.waitForFunction(() => __test.state.itemPageLoading);
    await page.evaluate(endSession => {
      if (endSession) __test.releaseSessionState();
      else return navigateToFolder(8, 'New');
    }, endSession);
    assert.equal((await page.evaluate(() => __oldRestore)).stale, true);
    assert.equal(await page.locator('.file-card').count(), 0);
  }
}

const fixture = await startUIFixture();
const failures = [];
const selected = process.env.TCLOUD_REVIEW_CASE;
const source = process.env.TCLOUD_REVIEW_SOURCE && await readFile(process.env.TCLOUD_REVIEW_SOURCE, 'utf8');
assert.ok(!selected || ['cache', 'origin'].includes(selected), 'unknown review case');
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of process.env.TCLOUD_REVIEW_DESKTOP_ONLY ? [false] : [false, true]) {
    for (const [label, run] of [['cache', cacheFailures], ['origin', originRange]]) {
      if (selected && selected !== label) continue;
      const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
      if (source) await page.route('**/cloud/cloud.js*', async route => {
        const response = await route.fetch(), served = await response.text();
        await route.fulfill({ response, body: source.replace('document.addEventListener("DOMContentLoaded", initialize);', '')
          + '\n' + served.slice(served.indexOf('globalThis.__test =')) });
      });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try { await run(page, fixture.origin); assert.deepEqual(errors, []); console.log('PASS review', label, name, mobile ? 'touch' : 'desktop'); }
      catch (error) { failures.push(error); console.error('FAIL review', label, name, mobile ? 'touch' : 'desktop', error); }
      finally { await page.close(); }
    }
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
if (failures.length) throw new AggregateError(failures, 'folder navigation review regressions');
