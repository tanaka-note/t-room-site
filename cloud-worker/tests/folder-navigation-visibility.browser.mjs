import assert from 'node:assert/strict';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

const fixture = await startUIFixture();
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

try { for (const [name, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
    const errors = [], gates = new Map();
    page.on('pageerror', error => errors.push(error.message));
    const hold = (folderId, status = 200) => {
      const gate = { requested: deferred(), release: deferred(), status };
      gates.set(folderId, gate);
      return gate;
    };
    const snapshot = () => page.evaluate(() => {
      const visible = node => getComputedStyle(node).visibility === 'visible' && getComputedStyle(node).display !== 'none';
      return {
        busy: document.querySelector('.workspace').inert,
        folderId: __test.state.folderId,
        title: document.querySelector('#view-title').textContent,
        titleVisible: visible(document.querySelector('#view-title')),
        files: [...document.querySelectorAll('.file-card')].map(node => ({ id: Number(node.dataset.fileId), visible: visible(node) }))
      };
    });
    const hidden = async () => {
      await frames(page);
      const view = await snapshot();
      assert.equal(view.busy, true);
      assert.equal(view.titleVisible, false, 'the preceding folder title cannot paint while navigation is pending');
      assert.ok(view.files.every(file => !file.visible), 'the preceding folder data cannot paint while navigation is pending');
      return view;
    };
    const committed = async folderId => {
      await page.waitForFunction(() => !document.querySelector('.workspace').inert);
      await frames(page);
      const view = await snapshot();
      assert.equal(view.folderId, folderId);
      assert.equal(view.titleVisible, true, 'the completed destination is revealed');
      assert.equal(view.files.length, 6);
      assert.ok(view.files.every(file => file.visible && Math.floor(file.id / 100) === folderId), 'only the destination records are displayed');
    };
    await page.route('**/cloud/api/**', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith('/items')) { await route.fulfill({ json: {} }); return; }
      const folderId = Number(url.searchParams.get('folderId'));
      const gate = gates.get(folderId);
      if (gate) { gates.delete(folderId); gate.requested.resolve(); await gate.release.promise; }
      if (gate && gate.status !== 200) { await route.fulfill({ status: gate.status, json: { error: 'Synthetic denied folder' } }); return; }
      const folderName = ({ 10: 'A', 20: 'B', 30: 'C' })[folderId];
      await route.fulfill({ json: {
        folders: folderId < 30 ? [{ id: folderId + 10, name: folderId === 10 ? 'B' : 'C', cryptoVersion: 0, isUnlocked: true }] : [],
        files: Array.from({ length: 6 }, (_, index) => ({ id: folderId * 100 + index + 1, folderId,
          name: `${folderName}-data-${index + 1}.txt`, cryptoVersion: 0, mediaKind: 'document', mimeType: 'text/plain', sizeBytes: 12 })),
        breadcrumbs: [], nextFolderOffset: null, nextFileOffset: null
      } });
    });
    const pending = [];
    try {
      await preparePage(page, fixture.origin, 0);
      await page.evaluate(async () => {
        globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, supported: () => false };
        await navigateToFolder(10, 'A');
        await openFolder(__test.state.folders.find(folder => folder.id === 20));
        await openFolder(__test.state.folders.find(folder => folder.id === 30));
      });
      for (const [direction, from, to] of [['back', 30, 20], ['back', 20, 10], ['forward', 10, 20]]) {
        const gate = hold(to); pending.push(gate);
        await page.evaluate(direction => history[direction](), direction);
        await gate.requested.promise;
        const view = await hidden();
        assert.equal(view.folderId, to);
        assert.ok(view.files.every(file => Math.floor(file.id / 100) === from), 'retain layout until the destination and position are ready');
        gate.release.resolve();
        await committed(to);
      }
      // A superseded request must not reveal the old list while its replacement waits.
      const previous = hold(10); pending.push(previous);
      await page.evaluate(() => history.back());
      await previous.requested.promise;
      await hidden();
      const replacement = hold(30); pending.push(replacement);
      await page.evaluate(() => { globalThis.__visibilityNavigation = navigateToFolder(30, 'C'); });
      await replacement.requested.promise;
      previous.release.resolve();
      await hidden();
      replacement.release.resolve();
      assert.equal((await page.evaluate(() => __visibilityNavigation)).ok, true);
      await committed(30);
      // A denied destination reveals the empty error state, never the source data.
      const denied = hold(20, 403); pending.push(denied);
      await page.evaluate(() => { globalThis.__visibilityNavigation = navigateToFolder(20, 'B'); });
      await denied.requested.promise;
      await hidden();
      denied.release.resolve();
      assert.equal((await page.evaluate(() => __visibilityNavigation)).ok, false);
      const failure = await snapshot();
      assert.equal(failure.busy, false);
      assert.equal(failure.titleVisible, true);
      assert.deepEqual(failure.files, []);
      await page.evaluate(() => navigateToFolder(10, 'A'));
      await committed(10);
      assert.deepEqual(errors, []);
      console.log('PASS folder navigation visibility', name, mobile ? 'touch' : 'desktop', 'nested Back/Forward, supersession, denial and recovery');
    } finally {
      pending.forEach(gate => gate.release.resolve());
      await page.close();
    }
  } } finally { await browser.close(); }
} } finally { await fixture.close(); }
