// Node-only state-machine fixtures: no browser, network or performance measurements.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source = readFileSync(new URL('../public/diary.js', import.meta.url), 'utf8');

function albumFixture({ total = 5001, pageMs = 0, overReturn = 0, emptyPage = false } = {}) {
  const state = { photos: [], photoOffset: 0, photoHasMore: false, photoLoading: false, photoRequestId: 0 };
  const node = () => ({ children: [], dataset: {}, setAttribute() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; } });
  const elements = { cameraRollMore: {}, cameraRollGrid: node(), cameraRollStatus: {} };
  const requests = [], pending = [];
  let now = 0, failOffset = -1, pauseOffset = -1;
  const api = async path => {
    const url = new URL(path, 'https://fixture.test');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    requests.push({ offset, limit, url });
    if (offset === pauseOffset) await new Promise(resolve => pending.push(resolve));
    if (offset === failOffset) { failOffset = -1; throw new Error('fixture album failure'); }
    now += pageMs;
    const photos = Array.from({ length: emptyPage ? 0 : Math.max(0, Math.min(limit + overReturn, total - offset)) }, (_, i) => ({ id: offset + i, entryDate: '2026-10-01' }));
    return { photos, hasMore: emptyPage || offset + photos.length < total };
  };
  const constants = [...source.matchAll(/  const CAMERA_ROLL_\w+ = \d+;/g)].map(match => match[0]).join('\n');
  const functions = ['cancelCameraRollLoad', 'loadPhotos', 'renderCameraRoll'].map(body).join('\n');
  const loaded = new Function('state', 'elements', 'api', 'performance', 'document', 'window', `
    ${constants}
    const createEmpty = () => ({}), formatDate = value => value, formatShortDate = value => value;
    ${functions}
    return { loadPhotos, cancelCameraRollLoad, max: CAMERA_ROLL_MAX_PHOTOS };
  `)(state, elements, api, { now: () => now }, { createElement: node }, { clearTimeout() {} });
  return { ...loaded, state, elements, requests, pending,
    failAt(offset) { failOffset = offset; }, pauseAt(offset) { pauseOffset = offset; } };
}

test('album opens with 48 photos, expands to the total cap and cannot grow on repeated clicks', async () => {
  for (const total of [4799, 4800, 4801, 100000]) {
    const f = albumFixture({ total });
    await f.loadPhotos(true);
    assert.equal(f.state.photos.length, 48);
    const firstCard = f.elements.cameraRollGrid.children[0];
    await Promise.all([f.loadPhotos(false), f.loadPhotos(false)]);
    assert.equal(f.state.photos.length, Math.min(total, f.max));
    assert.equal(f.elements.cameraRollGrid.children.length, f.state.photos.length);
    assert.equal(f.elements.cameraRollGrid.children[0], firstCard, 'appending retains earlier cards');
    assert.equal(new Set(f.state.photos.map(p => p.id)).size, f.state.photos.length);
    assert.equal(f.elements.cameraRollMore.hidden, true);
    assert.equal(f.elements.cameraRollStatus.textContent.includes('表示上限'), total > f.max);
    assert.ok(f.requests.every(r => r.limit >= 1 && r.limit <= 96));
    const count = f.requests.length;
    // No user-visible button exists at the cap; guard the loader as well.
    if (total >= f.max) { await f.loadPhotos(false); assert.equal(f.requests.length, count); }
  }
});

test('album month and search results share the cap, and reset frees the old list', async () => {
  const f = albumFixture();
  f.state.photoMonth = '2026-10'; f.state.photoEntryQuery = 'tag'; f.state.photoFileNameQuery = 'file';
  await f.loadPhotos(true); await f.loadPhotos(false);
  assert.equal(f.state.photos.length, f.max);
  assert.ok(f.requests.every(r => r.url.searchParams.get('month') === '2026-10'
    && r.url.searchParams.get('entryQuery') === 'tag' && r.url.searchParams.get('fileName') === 'file'));
  const oldPhotos = f.state.photos;
  await f.loadPhotos(true);
  assert.notEqual(f.state.photos, oldPhotos);
  assert.equal(f.state.photos.length, 48);
  assert.equal(f.elements.cameraRollGrid.children.length, 48);
  assert.equal(f.elements.cameraRollMore.hidden, false);
  assert.doesNotMatch(f.elements.cameraRollStatus.textContent, /表示上限/);
});

test('album stops requesting pages after the time budget and resumes at the exact offset', async () => {
  const f = albumFixture({ pageMs: 4000 });
  await f.loadPhotos(true); await f.loadPhotos(false);
  assert.deepEqual(f.requests.map(r => r.offset), [0, 48, 144]);
  assert.equal(f.state.photos.length, 240);
  assert.equal(f.elements.cameraRollMore.hidden, false);
  assert.equal(f.elements.cameraRollMore.disabled, false);
  await f.loadPhotos(false);
  assert.deepEqual(f.requests.map(r => r.offset), [0, 48, 144, 240, 336]);
});

test('album page failure retains successful pages and retry stays within total capacity', async () => {
  const f = albumFixture();
  await f.loadPhotos(true); f.failAt(144); await f.loadPhotos(false);
  assert.equal(f.state.photos.length, 144);
  assert.equal(f.elements.cameraRollStatus.textContent, 'fixture album failure');
  assert.equal(f.elements.cameraRollMore.disabled, false);
  await f.loadPhotos(false);
  assert.equal(f.state.photos.length, f.max);
  assert.deepEqual(f.requests.slice(0, 5).map(r => r.offset), [0, 48, 144, 144, 240]);
  assert.equal(f.requests.at(-1).limit, 48);
});

test('album close and filter reset invalidate pending pages and stop their request loop', async () => {
  for (const reset of [false, true]) {
    const f = albumFixture();
    await f.loadPhotos(true); f.pauseAt(48);
    const loading = f.loadPhotos(false);
    assert.equal(f.pending.length, 1);
    if (reset) { f.pauseAt(-1); await f.loadPhotos(true); }
    else f.cancelCameraRollLoad();
    const count = f.requests.length;
    f.pending.shift()(); await loading;
    assert.equal(f.state.photos.length, 48);
    assert.equal(f.requests.length, count);
    assert.equal(f.elements.cameraRollMore.disabled, false);
  }
});

test('album empty pages terminate even with hasMore; oversized pages cannot exceed the cap', async () => {
  const empty = albumFixture({ emptyPage: true });
  await empty.loadPhotos(true);
  assert.equal(empty.requests.length, 1);
  assert.equal(empty.state.photoHasMore, false);
  const oversized = albumFixture({ overReturn: 96 });
  await oversized.loadPhotos(true); await oversized.loadPhotos(false);
  assert.equal(oversized.state.photos.length, oversized.max);
  assert.equal(new Set(oversized.state.photos.map(p => p.id)).size, oversized.max);
});
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
  const state = { role: 'user', activeHouseholdId: 'household-a', accountName: 'account-a', entries: [1],
    query: 'saved search', month: '2026-09', monthExpanded: true };
  const elements = { appView: { hidden: false }, tagSearchInput: { value: 'tag' }, tagPageBack: { hidden: false } };
  const window = {
    location: { pathname: '/diary/', href: 'https://fixture.test/diary/', origin: 'https://fixture.test' },
    history: { state: { unrelated: 42 }, replaceState(value) { this.state = value; }, scrollRestoration: 'manual' },
    sessionStorage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    performance: { timeOrigin: Date.now(), getEntriesByType: () => [{ type: navigationType }] }
  };
  const document = { referrer: 'https://fixture.test/diary/favorites/' };
  let navigationType = 'navigate', cancellations = 0;
  const pagehide = source.slice(source.indexOf('    window.addEventListener("pagehide",'),
    source.indexOf('    document.querySelector("#passkey-login")'));
  const api = new Function('window', 'document', 'state', 'elements', 'cancelPositionRestoration', `
    const BASE_PATH = '/diary', RETURN_VIEW_STORAGE_KEY = 'troom-diary-return-view-v1';
    const RETURN_VIEW_HISTORY_KEY = 'troomDiaryReturnView', RETURN_NAVIGATION_KEY = 'troomDiaryReturnNavigation';
    const RETURN_VIEW_MAX_AGE_MS = 1800000, RETURN_NAVIGATION_MAX_AGE_MS = 30000;
    const captureEntryListPosition = () => ({ scrollY: 640 });
    const captureTagListPosition = () => ({ scrollTop: 80 });
    const isDiaryListRoute = () => true;
    ${body('storeDiaryReturnView')}
    ${body('isNewDiaryNavigation')}
    ${body('takeDiaryReturnView')}
    ${body('isUsableDiaryReturnView')}
    ${body('isDiaryReturnReferrer')}
    ${body('hasDiaryReturnNavigation')}
    ${body('isOwnedDiaryReturnView')}
    ${body('updateDiaryReturnNavigation')}
    ${body('configureDiaryReturnNavigation')}
    ${body('isDiaryListPath')}
    let hide;
    window.addEventListener = (type, callback) => { if (type === 'pagehide') hide = callback; };
    ${pagehide}
    return { store: storeDiaryReturnView, take: takeDiaryReturnView, hide, has: hasDiaryReturnNavigation, configure: configureDiaryReturnNavigation };
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
test('history and storage restoration require account and household ownership, including version 1', () => {
  const cases = [
    { label: 'matching ownership', patch: {}, accepted: true },
    { label: 'different account in same household', patch: { accountName: 'account-b' } },
    { label: 'missing account in same household', patch: { accountName: undefined } },
    { label: 'empty account', patch: { accountName: '' } },
    { label: 'different household', patch: { householdId: 'household-b' } },
    { label: 'missing household', patch: { householdId: undefined } },
    { label: 'empty household', patch: { householdId: '' } },
    { label: 'missing both identifiers', patch: { accountName: undefined, householdId: undefined } }
  ];
  for (const version of [1, 2]) {
    for (const type of ['reload', 'back_forward']) {
      for (const source of ['history', 'storage']) {
        for (const { label, patch, accepted = false } of cases) {
          const f = returnViewFixture();
          f.store('/diary/favorites/');
          const view = { ...JSON.parse(f.storage.get('troom-diary-return-view-v1')), version, ...patch };
          if (version === 1) delete view.routePath;
          // Isolate each source so fallback cannot hide a rejected snapshot.
          delete f.window.history.state.troomDiaryReturnView;
          f.storage.clear();
          if (source === 'history') f.window.history.state.troomDiaryReturnView = view;
          else f.storage.set('troom-diary-return-view-v1', JSON.stringify(view));
          f.setNavigation(type);
          const result = f.take('household-a');
          const context = `v${version} ${type} ${source}: ${label}`;
          if (accepted) {
            assert.equal(result?.query, 'saved search', context);
            assert.equal(result?.position.scrollY, 640, context);
          } else assert.equal(result, null, context);
        }
      }
    }
  }
});
test('fresh navigation ignores and clears only its own lifecycle snapshot', () => {
  const f = returnViewFixture();
  f.hide();
  assert.equal(f.take('household-a'), null);
  assert.equal(f.window.history.state.troomDiaryReturnView, undefined);
  assert.equal(f.window.history.state.unrelated, 42);
});

function openFavorites(f) {
  f.window.location.pathname = '/diary/favorites/';
  f.window.location.href = 'https://fixture.test/diary/favorites/';
  f.document.referrer = 'https://fixture.test/diary/';
  f.window.performance.timeOrigin = JSON.parse(f.storage.get('troomDiaryReturnNavigation')).savedAt + 10;
  // boot applies route state (including configure) before enterDiary takes a view.
  assert.match(body('boot'), /applyRouteState\(\);[\s\S]*enterDiary\(initialSession\)/);
  assert.match(body('applyRouteState'), /configureDiaryReturnNavigation\(\)/);
  f.configure();
  return f.take('household-a');
}
test('fresh same-URL access rejects retained history tokens before and after taking a view', () => {
  for (const pending of ['absent', 'other destination', 'malformed']) {
    const f = returnViewFixture();
    f.store('/diary/favorites/');
    const snapshot = f.storage.get('troom-diary-return-view-v1');
    f.window.history.state.troomDiaryReturnNavigation = JSON.parse(snapshot).savedAt;
    if (pending === 'absent') f.storage.delete('troomDiaryReturnNavigation');
    else f.storage.set('troomDiaryReturnNavigation', pending === 'malformed' ? '{' :
      JSON.stringify({ destinationPath: '/diary/tags/', savedAt: Date.now() }));
    f.window.location.pathname = '/diary/favorites/';
    f.configure();
    assert.equal(f.has('/diary/'), false, pending);
    assert.equal(f.take('household-a'), null);
    assert.equal(f.has('/diary/'), false);
    assert.equal(f.window.history.state.troomDiaryReturnNavigation, undefined);
    assert.equal(f.window.history.state.unrelated, 42);
    assert.equal(f.storage.get('troom-diary-return-view-v1'), snapshot);
  }
});
test('navigate from an internal link installs the new token and preserves valid back navigation', () => {
  const f = returnViewFixture();
  f.store('/diary/favorites/');
  const token = JSON.parse(f.storage.get('troomDiaryReturnNavigation')).savedAt;
  f.window.history.state.troomDiaryReturnNavigation = token - 1;
  assert.equal(openFavorites(f), null);
  assert.equal(f.window.history.state.troomDiaryReturnNavigation, token);
  assert.equal(f.window.history.state.unrelated, 42);
  assert.equal(f.storage.has('troomDiaryReturnNavigation'), false);
  assert.equal(f.has('/diary/'), true);
  assert.equal(f.has('/diary/tags/'), false);
  f.state.activeHouseholdId = 'household-b';
  assert.equal(f.has('/diary/'), false);
  f.state.activeHouseholdId = 'household-a';
  f.state.accountName = 'account-b';
  assert.equal(f.has('/diary/'), false);
});
test('reload and back/forward preserve the consumed internal token and current page snapshot', () => {
  for (const type of ['reload', 'back_forward']) {
    const f = returnViewFixture();
    f.store('/diary/favorites/');
    openFavorites(f);
    f.state.query = 'favorites search';
    f.hide();
    f.setNavigation(type);
    f.configure();
    const view = f.take('household-a');
    assert.equal(view.routePath, '/diary/favorites/');
    assert.equal(view.query, 'favorites search');
    assert.equal(view.position.scrollY, 640);
    assert.equal(f.has('/diary/'), true);
    assert.equal(f.window.history.state.unrelated, 42);
  }
});

test('interrupted handoff survives pagehide but is rejected after visiting another source', () => {
  const f = returnViewFixture();
  f.store('/diary/favorites/');
  const snapshot = f.storage.get('troom-diary-return-view-v1');
  const token = JSON.parse(f.storage.get('troomDiaryReturnNavigation')).savedAt;
  f.hide();
  f.window.location.pathname = '/diary/favorites/';
  f.window.location.href = 'https://fixture.test/diary/favorites/';
  f.document.referrer = 'https://fixture.test/diary/tags/';
  f.window.performance.timeOrigin = token + 10;
  f.window.history.state.troomDiaryReturnNavigation = token;
  f.configure();
  assert.equal(f.storage.has('troomDiaryReturnNavigation'), false);
  assert.equal(f.window.history.state.troomDiaryReturnNavigation, undefined);
  assert.equal(f.window.history.state.unrelated, 42);
  assert.equal(f.take('household-a'), null);
  assert.equal(f.has('/diary/'), false);
  assert.equal(f.storage.get('troom-diary-return-view-v1'), snapshot);
});
