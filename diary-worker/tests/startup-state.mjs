// Node-only state-machine fixtures: no browser, network or performance measurements.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source = readFileSync(new URL('../public/diary.js', import.meta.url), 'utf8');
function body(name) {
  const start = source.indexOf(`  function ${name}(`);
  const asyncStart = source.indexOf(`  async function ${name}(`);
  const from = start < 0 ? asyncStart : start;
  assert.ok(from >= 0, name);
  return source.slice(from, source.indexOf('\n  }', from) + 4);
}
function positionFixture() {
  const listeners = new Map(), frames = new Map(), calls = [];
  let next = 0, finishFonts;
  const window = {
    scrollY: 40, history: { scrollRestoration: 'manual' },
    addEventListener(type, fn) { listeners.set(type, fn); },
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; },
    cancelAnimationFrame(id) { frames.delete(id); },
    scrollTo(value) { calls.push(value); }, scrollBy(value) { calls.push(value); }
  };
  const document = { fonts: { status: 'loading', ready: new Promise(resolve => { finishFonts = resolve; }) } };
  const elements = { appView: { hidden: false }, entryList: { querySelector: () => null },
    tagList: { scrollTo() {}, scrollBy() {} } };
  const controller = source.slice(source.indexOf('  let positionVersion ='), source.indexOf('  await boot();'));
  const api = new Function('window', 'document', 'elements', `${controller}
    function resetHeaderVisibilityTracking() {}
    ${body('restoreEntryListPosition')}
    ${body('restoreTagListPosition')}
    ${body('restoreDiaryReturnPosition')}
    ${body('restoreDiaryReturnViewFromPageCache')}
    ${body('preserveViewport')}
    return { cancelPositionRestoration, restoreDiaryReturnPosition, restoreDiaryReturnViewFromPageCache,
      preserveViewport, getVersion: () => positionVersion };`)(window, document, elements);
  return { ...api, calls, window, finishFonts, emit: (type, value = {}) => listeners.get(type)?.(value),
    flush() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); }, frames };
}
const saved = { position: { scrollY: 600 } };
test('history restoration is instant; programmatic scroll events do not cancel it', () => {
  const f = positionFixture();
  f.restoreDiaryReturnPosition(saved);
  f.emit('scroll'); f.flush();
  assert.deepEqual(f.calls, [{ top: 600, left: 0, behavior: 'instant' }]);
});
test('input cancels queued frames, pending data restoration and late font correction', async () => {
  for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
    const f = positionFixture(), version = f.getVersion();
    f.restoreDiaryReturnPosition(saved, version);
    f.emit(type, { key: 'PageDown', target: { closest: () => null } });
    f.restoreDiaryReturnPosition(saved, version); // completion of an older request
    f.finishFonts(); await Promise.resolve(); f.flush();
    assert.deepEqual(f.calls, [], type);
    assert.equal(f.frames.size, 0);
  }
});
test('font changes can correct an untouched return; lifecycle cancellation and BFCache cannot replay it', async () => {
  const f = positionFixture();
  f.restoreDiaryReturnPosition(saved); f.flush();
  f.finishFonts(); await Promise.resolve(); f.flush();
  assert.equal(f.calls.length, 2);
  f.restoreDiaryReturnPosition(saved);
  f.restoreDiaryReturnViewFromPageCache({ persisted: true }); f.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.window.history.scrollRestoration, 'auto');
});
test('synchronous list commit retains the latest user position', () => {
  const f = positionFixture();
  f.window.scrollY = 320;
  f.preserveViewport(() => { f.window.scrollY = 500; });
  assert.deepEqual(f.calls, [{ top: 320, left: 0, behavior: 'instant' }]);
});
function entriesFixture({ count = 120, monthly = false, expanded = false, hook = () => {} } = {}) {
  const state = { entries: [], entryMap: new Map(), requestId: 0, monthExpanded: expanded, month: '2026-10',
    query: 'keyword', tag: 'tag', dateFrom: '2026-10-01', dateTo: '2026-10-31', favoritePage: true };
  const requests = [], renders = [];
  const elements = { entryList: { replaceChildren() {} }, loadMore: {}, searchStatus: {} };
  const api = async (path, options) => {
    requests.push({ path, options });
    const url = new URL(path, 'https://fixture.test');
    const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    const result = { entries: Array.from({ length: Math.max(0, Math.min(limit, count - offset)) }, (_, i) => ({ id: offset + i + 1 })),
      hasMore: offset + limit < count };
    await hook({ state, requests, renders });
    return path.startsWith('/bootstrap') ? { session: { authenticated: true }, households: {}, meta: {}, entries: result } : result;
  };
  const load = new Function('state', 'elements', 'api', 'renders', `
    let sessionGeneration = 1;
    const activeSessionContext = 'fixture', readingToolsReady = Promise.resolve();
    const window = { clearTimeout() {} };
    const isMonthlyView = () => ${monthly};
    const cancelPositionRestoration = () => {};
    const createEmpty = value => value, setBusy = () => {}, updateListHeading = () => {}, updateSearchStatus = () => {};
    const sessionContext = () => 'fixture', applyHouseholds = () => {}, applyMeta = () => {};
    const preserveViewport = render => render(), renderEntries = () => renders.push(state.entries.map(e => e.id));
    const resetState = () => {}, showLogin = () => {};
    ${body('loadEntries')}
    return { load: loadEntries, invalidateSession: () => { sessionGeneration++; } };`)(state, elements, api, renders);
  return { state, requests, renders, ...load };
}
test('return fetches 50/50/20 once each and commits the complete list once', async () => {
  const f = entriesFixture({ count: 140 });
  await f.load(true, true, 120);
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].length, 120);
  assert.equal(f.state.offset, 120); assert.equal(f.state.hasMore, true);
  assert.deepEqual(f.requests.map(r => Number(new URL(r.path, 'https://fixture.test').searchParams.get('limit'))), [50, 50, 20]);
  for (const r of f.requests) {
    const params = new URL(r.path, 'https://fixture.test').searchParams;
    assert.equal(params.get('q'), 'keyword'); assert.equal(params.get('tag'), 'tag');
    assert.equal(params.get('dateFrom'), '2026-10-01'); assert.equal(params.get('favorite'), '1');
  }
  await f.load(false);
  assert.equal(f.state.offset, 140); assert.equal(f.state.hasMore, false);
});
test('expanded month still loads the complete month in bounded pages', async () => {
  const f = entriesFixture({ count: 123, monthly: true, expanded: true });
  await f.load(true, true, 50);
  assert.equal(f.renders.length, 1); assert.equal(f.state.entries.length, 123);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every(r => new URL(r.path, 'https://fixture.test').searchParams.get('month') === '2026-10'));
});
test('new search invalidation prevents old return pages from continuing or committing', async () => {
  const f = entriesFixture({ hook({ state, requests }) { if (requests.length === 2) {
    state.entriesAbortController.abort(); state.requestId++;
  } } });
  await f.load(true, true, 120);
  assert.equal(f.requests.length, 2); assert.equal(f.renders.length, 0);
  assert.equal(f.requests[1].options.signal.aborted, true);
});
test('account/household generation change discards late return pages', async () => {
  const f = entriesFixture({ hook({ requests }) { if (requests.length === 2) f.invalidateSession(); } });
  await f.load(true, true, 120);
  assert.equal(f.requests.length, 2); assert.equal(f.renders.length, 0);
});
test('new navigation starts at zero before any wait; reload/history leave position to restoration', () => {
  const bootstrap = readFileSync(new URL('../public/diary-bootstrap.js', import.meta.url), 'utf8');
  const prefix = bootstrap.slice(bootstrap.indexOf('  const navigationType'), bootstrap.indexOf('  const button'));
  for (const type of ['navigate', 'back_forward', 'reload']) {
    const calls = [];
    const window = { performance: { getEntriesByType: () => [{ type }] }, location: { pathname: '/diary/' },
      history: { state: { troomDiaryReturnView: { routePath: '/diary/' } }, scrollRestoration: 'auto' },
      scrollTo: value => calls.push(value) };
    new Function('window', prefix)(window);
    assert.equal(calls.length, type === 'navigate' ? 1 : 0);
    if (type === 'navigate') assert.equal(calls[0].behavior, 'instant');
    else assert.equal(window.history.scrollRestoration, 'manual');
  }
  assert.match(bootstrap, /}, initialScrollIntent\);/);
  assert.match(body('enterDiary'), /initialScrollIntent\.interrupted \? -1 : positionVersion/);
  const style = readFileSync(new URL('../public/diary.css', import.meta.url), 'utf8');
  assert.match(style, /html \{[^}]*scroll-behavior: auto/);
});
test('viewer is prefetched independently, never a reading dependency', () => {
  const reading = source.slice(source.indexOf('  const readingToolsReady'), source.indexOf('  const BASE_PATH'));
  assert.doesNotMatch(reading, /photo-viewer/);
  assert.match(body('boot'), /loadPhotoViewer\(\)\.catch/);
  assert.match(body('openPhotoViewer'), /await loadPhotoViewer\(\)[\s\S]*generation !== sessionGeneration/);
});

function returnViewFixture() {
  const storage = new Map();
  const state = { activeHouseholdId: 'household-a', accountName: 'account-a', entries: [1],
    query: 'saved search', month: '2026-09', monthExpanded: true };
  const elements = { appView: { hidden: false }, tagSearchInput: { value: 'tag' } };
  const window = {
    location: { pathname: '/diary/', href: 'https://fixture.test/diary/', origin: 'https://fixture.test' },
    history: { state: { unrelated: 42 }, replaceState(value) { this.state = value; }, scrollRestoration: 'manual' },
    sessionStorage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    performance: { getEntriesByType: () => [{ type: navigationType }] }
  };
  const document = { referrer: 'https://fixture.test/diary/favorites/' };
  let navigationType = 'navigate', cancellations = 0;
  const pagehide = source.slice(source.indexOf('    window.addEventListener("pagehide",'),
    source.indexOf('    document.querySelector("#passkey-login")'));
  const api = new Function('window', 'document', 'state', 'elements', 'cancelPositionRestoration', `
    const BASE_PATH = '/diary', RETURN_VIEW_STORAGE_KEY = 'troom-diary-return-view-v1';
    const RETURN_VIEW_HISTORY_KEY = 'troomDiaryReturnView', RETURN_NAVIGATION_KEY = 'troomDiaryReturnNavigation';
    const RETURN_VIEW_MAX_AGE_MS = 1800000;
    const captureEntryListPosition = () => ({ scrollY: 640 });
    const captureTagListPosition = () => ({ scrollTop: 80 });
    const isDiaryListRoute = () => true;
    ${body('storeDiaryReturnView')}
    ${body('isNewDiaryNavigation')}
    ${body('takeDiaryReturnView')}
    ${body('isUsableDiaryReturnView')}
    ${body('isDiaryReturnReferrer')}
    ${body('hasDiaryReturnNavigation')}
    let hide;
    window.addEventListener = (type, callback) => { if (type === 'pagehide') hide = callback; };
    ${pagehide}
    return { store: storeDiaryReturnView, take: takeDiaryReturnView, hide, has: hasDiaryReturnNavigation };
  `)(window, document, state, elements, () => { cancellations++; });
  return { ...api, window, state, elements, storage, document,
    setNavigation: type => { navigationType = type; }, cancellations: () => cancellations };
}
test('pagehide preserves the source return view and navigation token across favorites and fresh access', () => {
  const f = returnViewFixture();
  f.store('/diary/favorites/');
  const saved = f.storage.get('troom-diary-return-view-v1');
  const token = f.storage.get('troomDiaryReturnNavigation');
  f.hide();
  assert.equal(f.storage.get('troom-diary-return-view-v1'), saved);
  assert.equal(f.storage.get('troomDiaryReturnNavigation'), token);
  f.window.location.pathname = '/diary/favorites/';
  f.window.history.state = { unrelated: 42, troomDiaryReturnNavigation: JSON.parse(saved).savedAt };
  f.storage.delete('troomDiaryReturnNavigation'); // consumed by the destination
  f.state.query = 'favorites search';
  f.hide(); // favorites -> other page
  assert.equal(f.storage.get('troom-diary-return-view-v1'), saved);
  assert.equal(f.storage.has('troomDiaryReturnNavigation'), false);
  assert.equal(f.window.history.state.troomDiaryReturnView.routePath, '/diary/favorites/');
  assert.equal(f.window.history.state.unrelated, 42);
  f.window.history.state = {}; // direct navigation back to favorites
  assert.equal(f.take('household-a'), null);
  assert.equal(f.storage.get('troom-diary-return-view-v1'), saved);
  assert.equal(f.has('/diary/'), false, 'stale source cannot trigger history.back');
  assert.equal(f.cancellations(), 2);
  assert.equal(f.window.history.scrollRestoration, 'auto');
});
test('pagehide keeps the current page restorable on reload/back/forward, with scope checks', () => {
  for (const type of ['reload', 'back_forward']) {
    const f = returnViewFixture();
    f.hide();
    assert.equal(f.storage.size, 0, 'lifecycle snapshots belong only to history');
    f.setNavigation(type);
    const saved = f.take('household-a');
    assert.equal(saved.query, 'saved search');
    assert.equal(saved.position.scrollY, 640);
    assert.equal(f.take('household-b'), null);
    f.state.accountName = 'account-b';
    assert.equal(f.take('household-a'), null);
  }
});
test('fresh navigation ignores and clears only its own lifecycle snapshot', () => {
  const f = returnViewFixture();
  f.hide();
  assert.equal(f.take('household-a'), null);
  assert.equal(f.window.history.state.troomDiaryReturnView, undefined);
  assert.equal(f.window.history.state.unrelated, 42);
});
