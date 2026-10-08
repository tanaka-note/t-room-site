import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try {
    const page = await browser.newPage(); await preparePage(page, fixture.origin, 0);
    const result = await page.evaluate(() => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      const state = __test.state, session = state.session, cryptoState = state.crypto;
      const upload = state.uploadAbort = new AbortController(), download = state.downloadAbort = new AbortController();
      const player = state.previewPlayer = { fixture: true };
      state.previewToken = 'fixture-preview'; state.uploading = true; state.downloading = true;
      const key = { fixture: 'device-key' }; cryptoState.folderKeys.set(99, key);
      state.folders = [{ id: 9, name: 'フォルダ', isProtected: false }];
      state.files = [{ id: 1, name: 'file10', mediaKind: 'document' }, { id: 2, name: 'file2', mediaKind: 'document' }];
      state.itemRenderLimit = 3;
      const create = TCloudListingView.create; let snapshots = 0;
      globalThis.TCloudListingView = { create: options => {
        const renderer = create(options);
        return { ...renderer, render: (snapshot, handlers) => {
          check(Object.isFrozen(snapshot), 'render snapshot must be immutable');
          check(Object.keys(snapshot).sort().join() === 'files,folders,generation,limit,listMode,query,view', 'render capabilities must be limited');
          check([...snapshot.files, ...snapshot.folders].every(record => Object.isFrozen(record) && Object.keys(record).sort().join() === 'id,name,revision'), 'keys must not cross display boundary');
          snapshots++; return renderer.render(snapshot, handlers);
        } };
      } };
      __test.renderItems();
      const grid = document.querySelector('#content-grid'), original = [...grid.children];
      state.listMode = true; state.query = 'file'; state.files.reverse(); __test.renderItems();
      check(grid.children[0] === original[0] && grid.children[1] === original[2] && grid.children[2] === original[1], 'ordering must retain unchanged card nodes');
      check(grid.classList.contains('list-mode') && grid.querySelectorAll('mark').length === 2, 'layout and highlighting must work');
      check(state.session === session && state.crypto === cryptoState && cryptoState.folderKeys.get(99) === key, 'auth and keys must be unchanged');
      check(state.uploadAbort === upload && state.downloadAbort === download && !upload.signal.aborted && !download.signal.aborted && state.uploading && state.downloading, 'transfers must be unchanged');
      check(state.previewPlayer === player && state.previewToken === 'fixture-preview', 'preview must be unchanged');
      check(snapshots === 2, 'host must use the restricted renderer');

      const gridA = document.createElement('div'), gridB = document.createElement('div'); document.body.append(gridA, gridB);
      const observers = [];
      const make = grid => create({ grid, highlight: TCloudUI.highlightText, createObserver: callback => {
        const observer = { callback, disconnect() { this.disconnected = true; }, observe() {} };
        observers.push(observer); return observer;
      } });
      const a = make(gridA), b = make(gridB);
      const records = Object.freeze([{ id: 1, name: '一', revision: 1 }, { id: 2, name: '二', revision: 2 }].map(Object.freeze));
      const createCard = (kind, id) => { const card = document.createElement('article'); card.className = kind + '-card'; card.append(document.createElement('strong')); card.dataset.id = id; return card; };
      const snapshot = { view: 'all', generation: 1, listMode: false, query: '', limit: 1, folders: [], files: records };
      a.render(snapshot, { createCard }); b.render({ ...snapshot, limit: 2 }, { createCard });
      let reveals = 0, loads = 0; const handlers = { reveal: () => reveals++, loadMore: () => loads++ };
      a.observe({ view: 'all', total: 2, progressive: true }, handlers); const old = observers.at(-1);
      a.render({ ...snapshot, generation: 2 }, { createCard }); old.callback([{ isIntersecting: true }]);
      check(reveals === 0 && loads === 0 && old.disconnected, 'queued callbacks from an old view must be ignored');
      a.observe({ view: 'all', total: 2, progressive: true }, handlers); const current = observers.at(-1);
      current.callback([{ isIntersecting: true }]); current.callback([{ isIntersecting: true }]);
      check(reveals === 1 && loads === 0, 'observer must request only one reveal');
      a.render({ ...snapshot, limit: 2 }, { createCard }); a.observe({ view: 'all', total: 2, progressive: true }, handlers);
      observers.at(-1).callback([{ isIntersecting: true }]); check(loads === 1, 'full page must request the next page');
      a.append({ folders: [{ id: 9, name: '九', revision: 9 }], files: [], limit: 3 }, { createCard });
      check(gridA.firstChild.dataset.renderKey === 'folder:9', 'progressive folders must precede files');
      check(gridB.querySelectorAll('.file-card').length === 2 && !gridB.querySelector('.item-render-sentinel'), 'instances must be independent');
      a.observe({ view: 'favorites', total: 4, progressive: true }, handlers);
      const resetObserver = observers.at(-1); a.reset(); resetObserver.callback([{ isIntersecting: true }]);
      check(reveals === 1 && loads === 1, 'reset must invalidate pending observations');
      const fallback = create({ grid: gridA, highlight: TCloudUI.highlightText, createObserver: null });
      fallback.observe({ view: 'all', total: 4, progressive: false }, handlers);
      const button = gridA.querySelector('button'); button.click(); button.click(); check(reveals === 2, 'manual fallback must reveal once');
      fallback.observe({ view: 'all', total: 4, progressive: false }, handlers);
      const detached = gridA.querySelector('button'); fallback.reset(); detached.click(); check(reveals === 2, 'removed controls must be inert');
      const historyNode = document.createElement('article'); historyNode.className = 'history-card';
      a.render({ ...snapshot, view: 'history', limit: 0, folders: [{ id: 9, name: '九', revision: 9 }] }, {
        createCard, renderOther: root => root.append(historyNode)
      });
      check(gridA.children.length === 4 && gridA.firstChild === historyNode && gridA.classList.contains('list-mode'), 'other views must keep their host cards and render without pagination limits');
      const observationCount = observers.length;
      a.observe({ view: 'history', total: 10, progressive: true }, handlers);
      check(observers.length === observationCount && !gridA.querySelector('.item-render-sentinel'), 'non-list views must not request pages');
      a.render({ ...snapshot, view: 'trash', limit: 0 }, { createCard });
      check(gridA.children.length === 2 && !gridA.classList.contains('list-mode'), 'trash must retain its unrestricted grid');
      a.render(snapshot, { createCard }); const beforeReplacement = gridA.firstChild;
      a.render({ ...snapshot, files: [{ ...records[0], revision: 3 }] }, { createCard });
      check(gridA.firstChild !== beforeReplacement, 'replaced records must rebuild their event handlers');
      const beforeGeneration = gridA.firstChild;
      a.render({ ...snapshot, generation: 3, files: [{ ...records[0], revision: 3 }] }, { createCard });
      check(gridA.firstChild !== beforeGeneration, 'new load generations must discard previous card bindings');
      return { snapshots, reveals, loads };
    });
    assert.deepEqual(result, { snapshots: 2, reveals: 2, loads: 1 });
    console.log('PASS listing isolation, retained cards, scoped DOM, progressive ordering, stale observer and fallback', name);
  } finally { await browser.close(); }
} } finally { await fixture.close(); }
