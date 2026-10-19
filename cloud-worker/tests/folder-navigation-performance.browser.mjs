import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

// Local synthetic API latency, real WebCrypto hydration and real browser layout.
// Instrumentation is injected by the test and never shipped to users.
const fixture = await startUIFixture();
let source = await readFile(process.env.TCLOUD_PERF_SOURCE || new URL('../public/cloud.js', import.meta.url), 'utf8');
if (process.env.TCLOUD_PERF_PAGE_SIZE) source = source.replace(/const RESTORE_ITEM_PAGE_SIZE = \d+;/,
  'const RESTORE_ITEM_PAGE_SIZE = ' + Number(process.env.TCLOUD_PERF_PAGE_SIZE) + ';');
const repeats = Number(process.env.TCLOUD_PERF_REPEATS || 7);
const counts = (process.env.TCLOUD_PERF_COUNTS || '160,500,1056').split(',').map(Number);
const latencies = (process.env.TCLOUD_PERF_LATENCIES || '15,80').split(',').map(Number);
const cacheDelay = Number(process.env.TCLOUD_PERF_CACHE_DELAY || 0);
const devices = process.env.TCLOUD_PERF_DEVICE === 'desktop' ? [false] : process.env.TCLOUD_PERF_DEVICE === 'touch' ? [true] : [false, true];
const results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try { for (const [engineName, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of devices) for (const count of counts) for (const latency of latencies) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
    await page.route('**/cloud/cloud.js*', async route => {
      const response = await route.fetch();
      const served = await response.text();
      const exposure = served.slice(served.indexOf('globalThis.__test ='));
      await route.fulfill({ response, body: source.replace('document.addEventListener("DOMContentLoaded", initialize);', '') + '\n' + exposure + `
        globalThis.__timings = [];
        for (const name of ['api', 'readDisplayListingCache', 'hydrateFolderRecords', 'hydrateFileRecords', 'loadNextItemPage', 'ensureNavigationOriginRendered']) {
          const original = eval(name);
          eval(name + ' = async function(...args) { const start = performance.now(), timings = __timings; try { return await original(...args); } finally { timings.push({name, ms: performance.now()-start}); } }');
        }
        const originalApply = applyNavigationPosition;
        applyNavigationPosition = function(...args) { const start = performance.now(); try { return originalApply(...args); } finally { __timings.push({name:'applyNavigationPosition', ms:performance.now()-start}); } };
      ` });
    });
    let records = [], maxResponseBytes = 0;
    await page.route('**/cloud/api/**', async route => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname.endsWith('/items')) {
        await new Promise(resolve => setTimeout(resolve, latency));
        const folder = Number(url.searchParams.get('folderId') || 0);
        const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('pageSize') || 32);
        const files = folder === 7 && !url.searchParams.has('foldersOnly') ? records.slice(offset, offset + size) : [];
        data = { folders: [], files, breadcrumbs: [], folder: {}, nextFolderOffset: null,
          nextFileOffset: folder === 7 && offset + size < count ? offset + size : null };
      }
      maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(JSON.stringify(data)));
      await route.fulfill({ json: data });
    });
    await preparePage(page, fixture.origin, 0);
    records = await page.evaluate(async ({ count, cacheDelay }) => {
      if (cacheDelay) {
        const get = TCloudDisplayCache.getListing;
        globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, getListing: async (...args) => {
          await new Promise(resolve => setTimeout(resolve, cacheDelay)); return get(...args);
        } };
      } else globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, supported: () => false };
      __test.state.crypto.folderKeys.set(7, __thumb.key);
      const pack = await TRoomCrypto.createFilePackage(new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' }), __thumb.key, 'document');
      const records = Array.from({ length: count }, (_, i) => ({ ...pack.payload, id: i + 1, folderId: 7,
        name: '[encrypted]', mediaKind: 'document', mimeType: 'text/plain', hasThumbnail: false, createdAt: '2026-10-01 00:00:00' }));
      globalThis.__perfPrepared = await hydrateFileRecords(records, { preserveOrder: true });
      return records;
    }, { count, cacheDelay });
    const samples = { normal: [], back: [] };
    for (let iteration = -1; iteration < repeats; iteration++) {
      console.log('SAMPLE', engineName, mobile ? 'touch' : 'desktop', count, latency, iteration);
      const measured = await page.evaluate(async () => {
        const measure = async action => {
          searchMetadataCache.clear(); __timings = [];
          const start = performance.now();
          await action();
          const commitMs = performance.now() - start;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { ms: performance.now() - start, commitMs, steps: [...__timings] };
        };
        await navigateToFolder(8, 'Empty');
        const normal = await measure(() => navigateToFolder(7, 'Files'));
        // Seed the saved, fully loaded listing outside both timed intervals.
        // Every measured restoration still downloads and decrypts all records anew.
        const deadline = performance.now() + 30000;
        while (__test.state.itemPageLoading) await new Promise(resolve => setTimeout(resolve, 1));
        __test.state.files = finalizeHydratedFiles(__perfPrepared);
        __test.state.itemLoadedFileIds = new Set(__test.state.files.map(file => Number(file.id)));
        __test.state.itemNextFileOffset = null; __test.state.progressiveItemsLoading = false;
        __test.state.itemRenderLimit = __test.state.files.length;
        __test.renderItems();
        document.querySelector('.file-card[data-file-id="90"]').scrollIntoView({ block: 'center' });
        const position = __test.appScrollPosition().y;
        await navigateToFolder(8, 'Empty', { originType: 'file', originId: 90 });
        const back = await measure(async () => {
          await new Promise(resolve => { addEventListener('popstate', resolve, { once: true }); history.back(); });
          while (document.querySelector('.workspace').inert) {
            if (performance.now() > deadline) throw new Error('Restoration timeout');
            await new Promise(resolve => setTimeout(resolve, 1));
          }
        });
        return { normal, back, position, restored: __test.appScrollPosition().y, loaded: __test.state.files.length };
      });
      assert.ok(Math.abs(measured.position - measured.restored) <= 2, JSON.stringify(measured));
      assert.equal(measured.loaded, count);
      if (iteration >= 0) for (const mode of ['normal', 'back']) samples[mode].push(measured[mode]);
    }
    for (const mode of ['normal', 'back']) {
      const values = samples[mode];
      const steps = {};
      for (const name of ['api', 'readDisplayListingCache', 'hydrateFolderRecords', 'hydrateFileRecords', 'loadNextItemPage', 'ensureNavigationOriginRendered', 'applyNavigationPosition']) {
        const sums = values.map(v => v.steps.filter(step => step.name === name).reduce((total, step) => total + step.ms, 0));
        steps[name] = { median: percentile(sums, .5), p95: percentile(sums, .95) };
      }
      const result = { engine: engineName, device: mobile ? 'touch' : 'desktop', count, latency, cacheDelay, maxResponseBytes, mode, n: repeats,
        median: percentile(values.map(v => v.ms), .5), p95: percentile(values.map(v => v.ms), .95), steps, samples: values };
      results.push(result);
      console.log('PERF', JSON.stringify({ ...result, samples: undefined }));
    }
    await page.close();
  } } finally { await browser.close(); }
} } finally {
  await fixture.close();
  if (process.env.TCLOUD_PERF_OUTPUT) {
    await mkdir(new URL('../../tmp/', import.meta.url), { recursive: true });
    await writeFile(process.env.TCLOUD_PERF_OUTPUT, JSON.stringify(results, null, 2));
  }
}
