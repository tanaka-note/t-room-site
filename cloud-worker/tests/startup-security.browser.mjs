import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const source = await readFile(new URL('../public/cloud.js', import.meta.url), 'utf8');
const failures = [];
async function check(label, run) {
  try { await run(); console.log('PASS', label); }
  catch (error) { failures.push(error); console.error('FAIL', label, error); }
}
await check('startup restoration failure propagation', async () => {
  const scrolls = [], error = new Error('Synthetic incomplete range');
  const context = vm.createContext({ state: { itemLoadGeneration: 1 }, navigationGeneration: 1,
    ensureNavigationOriginRendered: async () => ({ ok: false, error }),
    navigationOriginSelector: () => '', scrollAppTo: value => scrolls.push(value), appScrollPosition: () => ({ y: 845 }) });
  vm.runInContext(source.slice(source.indexOf('async function restoreNavigationPosition'), source.indexOf('async function prepareCryptoSession')), context);
  const result = await vm.runInContext('restoreNavigationPosition({tcloud:true,scrollY:845})', context);
  assert.deepEqual(scrolls, [], 'a failed restoration must never apply a position');
  assert.equal(result.ok, false); assert.equal(result.error, error);
});
await check('strict display fallback classification', () => {
  const canFallback = vm.runInNewContext(source.slice(source.indexOf('function canFallbackToDisplayListing'), source.indexOf('async function loadItems')) + ';canFallbackToDisplayListing',
    { TCloudSession: { isNetworkError: () => false } });
  for (const error of [new TypeError('Implementation failure'), new SyntaxError('Invalid JSON'), new Error('Unexpected failure')]) {
    assert.equal(canFallback(error), false, error.name + ' is not a proven network failure');
  }
});
for (const result of [{ ok: true }, { ok: false, restoreFailed: true }, { ok: false, stale: true }]) await check('startup completion status ' + JSON.stringify(result), async () => {
  let reports = 0;
  const context = vm.createContext({ state: {}, bindEvents() {}, TCloudOffline: { cleanupExpired: async () => {} }, window: { setInterval() {} },
    restoreInstalledAppPortrait: async () => {}, updateInstallButtons() {}, startupPasskeySessionId: () => '', clearLegacyPasskeyAdminKeys: async () => {},
    TCloudSession: { isBlocked: () => false, bind() {}, check() {} },
    api: async path => path === '/session' ? { authenticated: true, authMethod: 'passkey' } : {}, cleanupPasskeyCaches: async () => {},
    loadCachedPasskeyKeys: async () => ({}), enterApp: async () => result, reportCompletedAppUpdate: () => { reports++; } });
  vm.runInContext(source.slice(source.indexOf('async function initialize()'), source.indexOf('function bindEvents()')), context);
  await vm.runInContext('initialize()', context);
  assert.equal(reports, result.ok ? 1 : 0, 'failed or stale startup cannot overwrite its error with an update success notice');
});

async function startupCases(page, origin, onlyTransport = false) {
  let spec = {};
  await page.route('**/cloud/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/truncated-fixture')) { await route.continue(); return; }
    if (path.endsWith('/session')) { await route.fulfill({ json: { authenticated: false } }); return; }
    if (!path.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
    await new Promise(resolve => setTimeout(resolve, spec.apiDelay ?? 60));
    if (spec.network) { await route.abort('internetdisconnected'); return; }
    if (spec.malformed) { await route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid' }); return; }
    await route.fulfill({ status: spec.status || 200, json: spec.status >= 400 ? { error: 'Synthetic API error' }
      : { folders: spec.empty ? [] : [{ id: 888880, name: 'Fresh authorized folder', cryptoVersion: 0 }], files: [], breadcrumbs: [], nextFolderOffset: null, nextFileOffset: null } });
  });
  let passed = 0;
  const run = async options => {
    spec = options;
    await preparePage(page, origin, 0, { reload: options.flow === 'reload' });
    await page.evaluate(async options => {
      TCloudSession.bind = () => {};
      TCloudSession.isBlocked = () => false;
      const originalCheck = TCloudSession.check;
      globalThis.__guardValid = true;
      TCloudSession.check = () => { if (!__guardValid) throw Object.assign(new Error('Synthetic expired session'), { status: 419 }); return originalCheck(); };
      prepareCryptoSession = async () => {
        if (!options.locked) {
          if (!options.privateOnly) __test.state.crypto.folderKeys.set(7, __thumb.key);
          __test.state.crypto.adminPrivateKey = __thumb.key;
        }
      };
      scheduleUsageLoad = () => {}; scheduleLegacyFolderMigration = () => {};
      const apiCache = TCloudDisplayCache;
      globalThis.__cacheRead = { done: false, started: false };
      globalThis.TCloudDisplayCache = { ...apiCache, getListing: async (...args) => {
        __cacheRead.started = true;
        try {
          if (options.cacheDelay) await new Promise(resolve => setTimeout(resolve, options.cacheDelay));
          if (options.cacheFailure) throw new Error('Synthetic IDB failure');
          return await apiCache.getListing(...args);
        } finally { __cacheRead.done = true; }
      } };
      const session = { ...__test.state.session, loginId: 'fixture', credentialSalt: 'fixture', accountName: 'Synthetic account',
        ...(options.role ? { role: options.role, serviceAccountId: options.role === 'member' ? 'folder-member' : options.role,
          serviceLinkId: 'fixture-link', rootFolderId: 7 } : {}),
        ...(options.flow === 'resume' ? { authMethod: 'passkey' } : {}) };
      const folderId = options.flow === 'login' ? null : 7;
      __test.state.session = session; __test.state.folderId = folderId; restoreFolderSortPreference(folderId);
      const serverSort = __test.state.sortUsesTypeDefaults || __test.state.sort === 'name' ? 'updated-desc' : __test.state.sort + '-' + __test.state.sortDirection;
      const params = new URLSearchParams({ sort: serverSort }); if (folderId) params.set('folderId', '7');
      await apiCache.putListing(__test.displayCacheScope(), displayListingCacheKey(params), {
        folders: [{ id: 999990, name: 'Old startup cache', cryptoVersion: 0 }], files: [], breadcrumbs: [] });
      __test.state.historyReady = false;
      history.replaceState({ tcloud: true, folderId, folderName: 'Restored', view: 'all', sort: 'updated', sortDirection: 'desc', sortUsesTypeDefaults: true }, '', location.href);
      if (options.network) TCloudSession.fetch = __realSessionGuard.fetch;
      if (options.exception) TCloudSession.fetch = async () => { throw options.exception === 'TypeError' ? new TypeError('Synthetic implementation bug') : new Error('Synthetic implementation bug'); };
      if (options.decryptFailure) hydrateFileRecords = async () => { throw new DOMException('Synthetic decryption failure', 'OperationError'); };
      globalThis.__apiSettled = false;
      const originalApi = api;
      api = async (...args) => { try { return await originalApi(...args); } finally { if (args[0].startsWith('/items?')) __apiSettled = true; } };
      globalThis.__startupPaints = []; globalThis.__sampling = true;
      const sample = () => { if (!__sampling) return; __startupPaints.push({ cache: document.querySelectorAll('[data-folder-id="999990"]').length,
        title: document.querySelector('#view-title').textContent, apiSettled: __apiSettled }); requestAnimationFrame(sample); }; sample();
      globalThis.__startup = enterApp(session);
    }, options);
    if (options.change) {
      await page.waitForFunction(() => __cacheRead.done);
      await page.evaluate(change => {
        if (change === 'logout') __test.releaseSessionState();
        if (change === 'abort') __test.state.itemLoadController.abort();
        if (change === 'account') __test.state.session = { ...__test.state.session, serviceAccountId: 'other' };
        if (change === 'session') __test.state.session = { ...__test.state.session, sessionCacheId: 'other-session' };
        if (change === 'key') { __test.state.crypto.folderKeys.clear(); __test.state.crypto.adminPrivateKey = null; }
        if (change === 'expiry') __guardValid = false;
      }, options.change);
    }
    const result = await page.evaluate(async () => { const result = await __startup; return { ...result, error: result?.error && { status: result.error.status } }; });
    if (options.success && options.cacheDelay === 600) assert.equal(await page.evaluate(() => __cacheRead.done), false, 'API success never waits for 600ms IDB');
    if (options.cacheDelay) await page.waitForTimeout(options.cacheDelay + 20);
    const paints = await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); __sampling = false; return __startupPaints; });
    const allowCache = Boolean((options.status >= 500 || options.network) && !options.locked && !options.privateOnly && !options.cacheFailure && !options.change);
    assert.ok(paints.every(p => p.cache === 0 || (allowCache && p.apiSettled)), 'never paint unresolved or rejected cache: ' + JSON.stringify(options));
    assert.ok(paints.every(p => p.title !== 'Restored' || ((options.success || allowCache) && p.apiSettled)), 'saved private folder title must also wait for successful validation or an eligible fallback');
    assert.equal(await page.locator('[data-folder-id="999990"]').count(), allowCache ? 1 : 0, JSON.stringify(options));
    assert.equal(result.ok, Boolean(options.success || allowCache), JSON.stringify(options));
    if (allowCache) assert.equal(result.partial, true);
    if (options.success) assert.equal(await page.locator('[data-folder-id="888880"]').count(), options.empty ? 0 : 1);
    passed++;
  };
  if (!onlyTransport) {
  for (const flow of ['login', 'reload', 'resume']) {
    for (const status of [400, 401, 403, 404, 419, 423, 429]) for (const cacheDelay of [0, 90]) await run({ flow, status, cacheDelay });
    for (const status of [500, 502, 503, 504]) await run({ flow, status, cacheDelay: 90 });
    await run({ flow, success: true, cacheDelay: 0 });
    await run({ flow, success: true, apiDelay: 5, cacheDelay: 90 });
    await run({ flow, success: true, apiDelay: 5, cacheDelay: 600 });
    await run({ flow, success: true, empty: true, apiDelay: 5, cacheDelay: 600 });
    await run({ flow, network: true });
    await run({ flow, malformed: true });
    for (const exception of ['TypeError', 'Error']) await run({ flow, exception });
    await run({ flow, decryptFailure: true });
    await run({ flow, status: 503, cacheFailure: true });
    await run({ flow, status: 503, locked: true });
  }
  for (const change of ['logout', 'abort', 'account', 'session', 'key', 'expiry']) await run({ flow: 'resume', status: 500, apiDelay: 150, change });
  for (const change of ['account','session']) {
    await run({ flow: 'resume', status: 503 });
    spec = { status: 503, apiDelay: 150 };
    const switched = await page.evaluate(async change => {
      __apiSettled = false;
      const session = { ...__test.state.session, sessionCacheId: 'new-entry-session',
        ...(change === 'account' ? { serviceAccountId: 'other-account' } : {}) };
      const pending = enterApp(session);
      const paints = []; let sampling = true;
      const sample = () => { if (!sampling) return; paints.push({ cache: document.querySelectorAll('[data-folder-id="999990"]').length, settled: __apiSettled }); requestAnimationFrame(sample); }; sample();
      const result = await pending;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); sampling = false;
      return { paints, ok: result.ok, partial: result.partial };
    }, change);
    assert.ok(switched.paints.every(p => p.cache === 0 || (change === 'session' && p.settled)), 'new entry discards previous-account/session DOM before validation');
    assert.equal(switched.ok, change === 'session');
    if (change === 'session') assert.equal(switched.partial, true, 'a new authenticated session can independently read its own account cache after a classified outage');
    passed++;
  }
  for (const role of ['admin','subadmin','member']) for (const locked of [false,true]) await run({ flow: 'resume', status: 503, role, locked });
  await run({ flow: 'resume', status: 503, privateOnly: true });
  for (const status of [400, 401, 403, 404, 419, 423, 429]) {
    await run({ flow: 'resume', status: 503 });
    spec = { status, apiDelay: 10 };
    const denied = await page.evaluate(async () => { const result = await __test.loadItems(); return { ok: result.ok, status: result.error?.status }; });
    assert.deepEqual(denied, { ok: false, status });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.folder-card,.file-card').count(), 0, 'a denied revalidation clears previously displayed cached records');
    passed++;
  }
  }
  await preparePage(page, origin, 0);
  await page.evaluate(() => { __realSessionGuard.bind(__test.state.session, false); globalThis.TCloudSession = __realSessionGuard; });
  for (const mode of ['network', 'malformed', 'body-disconnect', 'http']) {
    spec = mode === 'network' ? { network: true } : mode === 'malformed' ? { malformed: true } : { status: 504 };
    const result = await page.evaluate(async mode => {
      globalThis.__headersSeen = false;
      const guard = __realSessionGuard;
      globalThis.TCloudSession = { ...guard, fetch: async (...args) => { const response = await guard.fetch(...args); __headersSeen = true; return response; } };
      try { await api(mode === 'body-disconnect' ? '/truncated-fixture' : '/items?folderId=7'); return { ok: true }; }
      catch (error) { return { network: TCloudSession.isNetworkError(error), fallback: canFallbackToDisplayListing(error), name: error.name, message: error.message, status: error.status, headersSeen: __headersSeen }; }
    }, mode);
    assert.equal(result.network, mode === 'network' || mode === 'body-disconnect', mode + ': ' + JSON.stringify(result));
    assert.equal(result.fallback, mode !== 'malformed', mode + ': ' + JSON.stringify(result));
    if (mode === 'body-disconnect') assert.equal(result.headersSeen, true, 'body transport error is classified after successful headers');
    passed++;
  }
  const invalidRequest = await page.evaluate(async () => {
    const controller = new AbortController(); controller.abort();
    const results = [];
    for (const options of [{ headers: { Bad: 'bad\nvalue' } }, { signal: controller.signal }]) {
      try { await TCloudSession.fetch('/cloud/api/items', options); results.push('unexpected success'); }
      catch (error) { results.push({ network: TCloudSession.isNetworkError(error), fallback: canFallbackToDisplayListing(error) }); }
    }
    return results;
  });
  assert.deepEqual(invalidRequest, [{ network: false, fallback: false }, { network: false, fallback: false }]);
  passed += 2;
  // A real reload with an unauthenticated /session cannot enter the cached app.
  await preparePage(page, origin, 0, { reload: true });
  await page.evaluate(async () => { TCloudSession.isBlocked = () => false; __test.releaseSessionState(); await __test.initialize(); });
  assert.equal(await page.locator('#app-view').isVisible(), false);
  assert.equal(await page.locator('.folder-card,.file-card').count(), 0);
  return passed + 1;
}

async function startupRestoration(page, origin) {
  let scenario = '', requests = 0;
  await page.route('**/cloud/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
    if (Number(url.searchParams.get('folderId')) === 8) { await route.fulfill({ json: { folders: [], files: [], breadcrumbs: [] } }); return; }
    requests++;
    const continuation = url.searchParams.has('continuation');
    if (continuation && ['abort','move','session'].includes(scenario)) await new Promise(resolve => setTimeout(resolve, 120));
    if (continuation && ['403','500'].includes(scenario)) { await route.fulfill({ status: Number(scenario), json: { error: 'Synthetic restore failure' } }); return; }
    const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('pageSize'));
    const filesOnly = url.searchParams.has('filesOnly'), foldersOnly = url.searchParams.has('foldersOnly');
    const missing = ['deleted','moved'].includes(scenario), capped = scenario === 'cap';
    const folderCount = ['normal','deleted','moved'].includes(scenario) ? 500 : 0;
    const ids = Array.from({ length: missing ? 5500 : 500 }, (_, i) => i + 1).filter(id => !missing || id !== 90);
    const fileIds = foldersOnly ? [] : ids.slice(capped && continuation ? 0 : offset, capped && continuation ? 32 : offset + size);
    const folders = filesOnly ? [] : Array.from({ length: Math.max(0, Math.min(size, folderCount - offset)) }, (_, i) => ({ id: 10000 + offset + i, name: 'Folder ' + (offset + i), cryptoVersion: 0 }));
    let nextFileOffset = offset + size < ids.length ? offset + size : null;
    if (capped) nextFileOffset = offset + size;
    if (continuation && scenario === 'nonprogress') nextFileOffset = offset;
    if (continuation && scenario === 'invalid') nextFileOffset = 'invalid';
    await route.fulfill({ json: { folders, files: fileIds.map(id => ({ id, folderId: 7, name: 'File ' + id, cryptoVersion: 0, mediaKind: 'document' })),
      breadcrumbs: [], nextFolderOffset: offset + size < folderCount ? offset + size : null, nextFileOffset } });
  });
  let passed = 0;
  for (const listMode of [true, false]) for (const mode of ['normal','deleted','moved','nonprogress','invalid','cap','403','500','abort','move','session']) {
    scenario = mode; requests = 0;
    await preparePage(page, origin, 0);
    await page.evaluate(({ mode, listMode }) => {
      TCloudSession.bind = () => {};
      prepareCryptoSession = async () => { __test.state.crypto.folderKeys.set(7, __thumb.key); };
      scheduleUsageLoad = () => {}; scheduleLegacyFolderMigration = () => {};
      globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, supported: () => false };
      const mixed = ['normal','deleted','moved'].includes(mode), missing = mode === 'deleted' || mode === 'moved';
      __test.state.historyReady = false;
      history.replaceState({ tcloud: true, folderId: 7, folderName: 'Restored', view: 'all', listMode,
        loadedFolderCount: mixed ? 160 : 0, loadedFileCount: mode === 'normal' ? 500 : missing ? 160 : 1056,
        renderLimit: 660, originType: 'file', originId: 90, originOffsetY: 300, scrollY: 2400 }, '', location.href);
      globalThis.__applied = 0; const original = applyNavigationPosition;
      applyNavigationPosition = (...args) => { __applied++; return original(...args); };
      globalThis.__restorePaints = []; globalThis.__sampling = true;
      const sample = () => { if (!__sampling) return; __restorePaints.push({ cards: document.querySelectorAll('.folder-card,.file-card').length,
        inert: document.querySelector('.workspace').inert, y: __test.appScrollPosition().y }); requestAnimationFrame(sample); }; sample();
      globalThis.__startup = enterApp({ ...__test.state.session, loginId: 'fixture', accountName: 'Synthetic account', credentialSalt: 'fixture' });
    }, { mode, listMode });
    if (['abort','move','session'].includes(mode)) {
      await page.waitForFunction(() => __test.state.itemPageLoading);
      await page.evaluate(mode => {
        if (mode === 'abort') __test.state.itemLoadController.abort();
        if (mode === 'move') return navigateToFolder(8, 'New');
        if (mode === 'session') { __test.releaseSessionState(); __test.prepare(0); __test.state.session.serviceAccountId = 'other'; }
      }, mode);
    }
    const result = await page.evaluate(async () => {
      const result = await __startup;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); __sampling = false;
      return { ok: result?.ok, stale: result?.stale, restoreFailed: result?.restoreFailed, status: result?.error?.status,
        files: __test.state.files.length, folders: __test.state.folders.length, folderNext: __test.state.itemNextFolderOffset,
        applied: __applied, y: __test.appScrollPosition().y,
        anchor: document.querySelector('[data-file-id="90"]')?.getBoundingClientRect().top,
        rootTop: appScrollRoot()?.getBoundingClientRect().top || 0, paints: __restorePaints,
        cards: document.querySelectorAll('.folder-card,.file-card').length, notice: document.querySelector('#notice').textContent };
    });
    const success = ['normal','deleted','moved'].includes(mode), stale = ['abort','move','session'].includes(mode);
    assert.equal(result.ok, success, mode);
    assert.equal(result.applied, success ? 1 : 0, 'position is applied only after successful atomic preparation: ' + mode);
    assert.ok(result.paints.every(p => !p.inert || p.cards === 0), 'startup restoration cannot paint a partial range');
    if (success) {
      assert.equal(result.folders, 160); assert.equal(result.folderNext, 160);
      assert.equal(result.files, mode === 'normal' ? 500 : 410);
      if (mode === 'normal') assert.ok(Math.abs(result.anchor - result.rootTop - 300) <= 2);
      else assert.ok(Math.abs(result.y - 2400) <= 2);
      assert.ok(result.paints.filter(p => p.cards).every(p => p.cards === result.cards && Math.abs(p.y - result.y) <= 2), 'only the final range and its position paint');
    } else {
      assert.equal(result.cards, 0);
      if (stale) assert.equal(result.stale, true);
      else { assert.equal(result.restoreFailed, true); assert.ok(result.notice); }
      if (mode === '403' || mode === '500') assert.equal(result.status, Number(mode));
      if (mode === 'cap') assert.equal(requests, 257, 'initial page plus the existing 256-page safety limit');
      if (mode === 'nonprogress' || mode === 'invalid') assert.equal(requests, 2, 'invalid offsets fail on the first continuation');
    }
    passed++;
  }
  return passed;
}

async function startupFallback(page, origin) {
  let requests = 0;
  await page.route('**/cloud/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
    requests++;
    await new Promise(resolve => setTimeout(resolve, 40));
    if (url.searchParams.has('folderId')) await route.fulfill({ status: 403, json: { error: 'Synthetic denied folder' } });
    else await route.fulfill({ json: { folders: [{ id: 888880, name: 'Authorized root', cryptoVersion: 0 }], files: [], breadcrumbs: [] } });
  });
  await preparePage(page, origin, 0);
  const result = await page.evaluate(async () => {
    TCloudSession.bind = () => {};
    prepareCryptoSession = async () => { __test.state.crypto.folderKeys.set(7, __thumb.key); __test.state.crypto.adminPrivateKey = __thumb.key; };
    scheduleUsageLoad = () => {}; scheduleLegacyFolderMigration = () => {};
    __test.state.historyReady = false;
    history.replaceState({ tcloud: true, folderId: 7, folderName: 'Private saved title', scrollY: 2400, loadedFileCount: 1056 }, '', location.href);
    const paints = []; let sampling = true;
    const sample = () => { if (!sampling) return; paints.push(document.querySelector('#view-title').textContent); requestAnimationFrame(sample); }; sample();
    const result = await enterApp({ ...__test.state.session, loginId: 'fixture', credentialSalt: 'fixture', accountName: 'Synthetic account' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); sampling = false;
    return { ok: result.ok, y: __test.appScrollPosition().y, folderId: __test.state.folderId, historyFolder: history.state.folderId,
      active: activeNavigationEntry?.navigationId, actual: history.state.navigationId, paints, notice: document.querySelector('#notice').textContent };
  });
  assert.equal(result.ok, true); assert.equal(result.folderId, null); assert.equal(result.historyFolder, null);
  assert.equal(result.active, result.actual, 'safe root fallback has the correct active history entry');
  assert.ok(Math.abs(result.y) <= 2); assert.ok(result.paints.every(title => title !== 'Private saved title'));
  assert.equal(requests, 2); assert.match(result.notice, /前回/);
  assert.equal(await page.locator('[data-folder-id="888880"]').count(), 1);
  return 1;
}

const fixture = await startUIFixture(undefined, { handleRequest(req, res) {
  if (new URL(req.url, 'http://localhost').pathname !== '/cloud/api/truncated-fixture') return false;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
  res.write('{"files":[');
  setTimeout(() => res.destroy(), 200);
  return true;
} });
const group = process.env.TCLOUD_STARTUP_GROUP;
assert.ok(!group || ['transport','cache','restore','fallback'].includes(group));
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      const count = group === 'restore' || group === 'fallback' ? 0 : await startupCases(page, fixture.origin, group === 'transport');
      const restorations = group && group !== 'restore' ? 0 : await startupRestoration(page, fixture.origin);
      const fallbacks = !group || group === 'fallback' ? await startupFallback(page, fixture.origin) : 0;
      assert.deepEqual(errors, []); console.log('PASS startup security', name, mobile ? 'touch' : 'desktop', count, 'cache/transport cases', restorations, 'restoration cases', fallbacks, 'root fallback cases');
    }
    catch (error) { failures.push(error); console.error('FAIL startup security', name, mobile ? 'touch' : 'desktop', error); }
    finally { await page.close(); }
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
if (failures.length) throw new AggregateError(failures, 'startup security regressions');
