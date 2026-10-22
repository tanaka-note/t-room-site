import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { engines, startUIFixture, preparePage } from './ui-fixture.mjs';

// Local synthetic API, distinct real WebCrypto envelopes and browser layout.
// Instrumentation and concurrency overrides only affect this test's served copy.
const integer = (value, name) => {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, `Invalid ${name}: ${value}`);
  return number;
};
const repeats = integer(process.env.TCLOUD_PERF_REPEATS || 7, 'repeats');
const counts = (process.env.TCLOUD_PERF_COUNTS || '160,500,1056').split(',').map(v => integer(v, 'count'));
const latencies = (process.env.TCLOUD_PERF_LATENCIES || '15,80').split(',').map(Number);
assert.ok(latencies.every(v => Number.isFinite(v) && v >= 0), 'Invalid latency');
const concurrencies = (process.env.TCLOUD_PERF_CONCURRENCIES || '4,8,12,16').split(',').map(v => integer(v, 'concurrency'));
assert.equal(new Set(concurrencies).size, concurrencies.length, 'Duplicate concurrency');
const cacheDelay = Number(process.env.TCLOUD_PERF_CACHE_DELAY || 0);
assert.ok(Number.isFinite(cacheDelay) && cacheDelay >= 0, 'Invalid cache delay');
assert.ok(!process.env.TCLOUD_PERF_DEVICE || ['desktop', 'touch'].includes(process.env.TCLOUD_PERF_DEVICE), 'Invalid device');
const devices = process.env.TCLOUD_PERF_DEVICE === 'desktop' ? [false] : process.env.TCLOUD_PERF_DEVICE === 'touch' ? [true] : [false, true];
let source = await readFile(process.env.TCLOUD_PERF_SOURCE || new URL('../public/cloud.js', import.meta.url), 'utf8');
if (process.env.TCLOUD_PERF_PAGE_SIZE) source = source.replace(/const RESTORE_ITEM_PAGE_SIZE = \d+;/,
  'const RESTORE_ITEM_PAGE_SIZE = ' + integer(process.env.TCLOUD_PERF_PAGE_SIZE, 'page size') + ';');
const hydrationStart = source.indexOf('async function hydrateFileRecords(');
assert.ok(hydrationStart >= 0, 'Missing hydration function');
const hydrationEnd = source.indexOf('\nfunction listingPreferences(', hydrationStart);
assert.ok(hydrationEnd > hydrationStart, 'Missing hydration boundary');
let hydration = source.slice(hydrationStart, hydrationEnd);
const productionCall = 'mapWithConcurrency(records, 8, async (original) => {';
assert.ok(hydration.includes(productionCall), 'Recheck instrumentation after production concurrency changes');
hydration = hydration.replace(productionCall, '__perfMap(records, async (original) => {');
const folderLookup = 'let folderKey = state.crypto.folderKeys.get(Number(file.folderId));';
assert.ok(hydration.includes(folderLookup));
hydration = hydration.replace(folderLookup, 'const folderStarted = performance.now();\n      ' + folderLookup);
const folderBranch = 'if (!folderKey) {\n        file.name';
assert.ok(hydration.includes(folderBranch));
hydration = hydration.replace(folderBranch, '__timings.push({name:"folderKey", ms:performance.now()-folderStarted});\n      ' + folderBranch);
source = source.slice(0, hydrationStart) + hydration + source.slice(hydrationEnd);
const results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const fixture = await startUIFixture();
try { for (const [engineName, engine, launch] of engines) {
  const browser = await engine.launch({ headless: true, ...launch });
  try { for (const mobile of devices) for (const count of counts) for (const latency of latencies) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/cloud/cloud.js*', async route => {
      const response = await route.fetch();
      const served = await response.text(), exposureIndex = served.indexOf('globalThis.__test =');
      assert.ok(exposureIndex >= 0, 'Missing fixture exposure');
      await route.fulfill({ response, body: source.replace('document.addEventListener("DOMContentLoaded", initialize);', '') + '\n' + served.slice(exposureIndex) + `
        globalThis.__timings = [];
        globalThis.__perfConcurrency = 8;
        globalThis.__perfHistoryEvents = [];
        for (const name of ['pushState', 'replaceState']) {
          const original = history[name].bind(history);
          history[name] = (...args) => {
            const result = original(...args);
            __perfHistoryEvents.push(performance.now());
            return result;
          };
        }
        globalThis.__perfMap = async (records, mapper) => {
          const timings = __timings, queued = performance.now();
          let active = 0;
          const peak = {name:'mapperPeak', ms:0}; timings.push(peak);
          return mapWithConcurrency(records, __perfConcurrency, async (record, index) => {
            timings.push({name:'mapperQueue', ms:performance.now()-queued});
            peak.ms = Math.max(peak.ms, ++active);
            try { return await mapper(record, index); } finally { active--; }
          });
        };
        for (const name of ['api', 'readDisplayListingCache', 'hydrateFolderRecords', 'hydrateFileRecords', 'loadNextItemPage', 'ensureNavigationOriginRendered']) {
          const original = eval(name);
          eval(name + ' = async function(...args) { const start = performance.now(), timings = __timings; try { return await original(...args); } finally { timings.push({name, ms: performance.now()-start, ...(name === "api" ? {items: String(args[0]).startsWith("/items?")} : {})}); } }');
        }
        for (const name of ['renderItems', 'applyNavigationPosition']) {
          const original = eval(name);
          eval(name + ' = function(...args) { const start = performance.now(); try { return original(...args); } finally { __timings.push({name, ms:performance.now()-start}); } }');
        }
        const measuredCrypto = { ...TRoomCrypto };
        for (const name of ['unlockFileKey', 'decryptFileMetadata']) {
          const original = TRoomCrypto[name];
          measuredCrypto[name] = async (...args) => {
            const timings = __timings, start = performance.now();
            try { return await original(...args); } finally { timings.push({name, ms:performance.now()-start, start, end:performance.now()}); }
          };
        }
        globalThis.TRoomCrypto = measuredCrypto;
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
      // Disabling supported() also disables the in-memory metadata cache.
      // Keep the real display cache enabled even when no IDB delay is requested.
      const get = TCloudDisplayCache.getListing;
      globalThis.TCloudDisplayCache = { ...TCloudDisplayCache, getListing: async (...args) => {
        if (cacheDelay) await new Promise(resolve => setTimeout(resolve, cacheDelay));
        return get(...args);
      } };
      if (count > SEARCH_METADATA_CACHE_LIMIT) throw new Error('Count exceeds warm metadata cache capacity');
      __test.state.crypto.folderKeys.set(7, __thumb.key);
      const records = [];
      for (let i = 0; i < count; i++) {
        const name = 'synthetic-' + String(i + 1).padStart(5, '0') + '.txt';
        const pack = await TRoomCrypto.createFilePackage(new File(['synthetic ' + i], name,
          { type: 'text/plain', lastModified: 1790812800000 + i }), __thumb.key, 'document');
        records.push({ ...pack.payload, id: i + 1, folderId: 7, name: '[encrypted]',
          mediaKind: 'document', mimeType: 'text/plain', hasThumbnail: false, createdAt: '2026-10-01 00:00:00' });
      }
      globalThis.__perfRecords = records;
      return records;
    }, { count, cacheDelay });
    for (const field of ['encryptedMetadata', 'metadataIv', 'wrappedFileKey', 'fileKeyIv']) {
      assert.equal(new Set(records.map(record => record[field])).size, count, `Distinct ${field}`);
    }
    const modes = ['hydrate-cold', 'hydrate-warm', 'normal', 'back'];
    const samples = new Map(concurrencies.map(limit => [limit, Object.fromEntries(modes.map(mode => [mode, []]))]));
    for (let iteration = -1; iteration < repeats; iteration++) {
      // Rotate candidate positions and reverse alternate rounds on the same data.
      const offset = (iteration + 1) % concurrencies.length;
      const order = [...concurrencies.slice(offset), ...concurrencies.slice(0, offset)];
      if (iteration % 2 === 1) order.reverse();
      for (const concurrency of order) {
        console.log('SAMPLE', engineName, mobile ? 'touch' : 'desktop', count, latency, iteration, concurrency);
        const measured = await page.evaluate(async ({ concurrency, count }) => {
          __perfConcurrency = concurrency;
          // WebKit limits History mutations to 100 per 10 seconds. Pace the
          // synthetic burst outside all timed intervals; keep real History calls.
          while (true) {
            __perfHistoryEvents = __perfHistoryEvents.filter(time => performance.now() - time < 11000);
            if (__perfHistoryEvents.length < 50) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const idle = async () => {
            const deadline = performance.now() + 30000;
            while (__test.state.itemPageLoading || document.querySelector('.workspace').inert) {
              if (performance.now() > deadline) throw new Error('Navigation timeout');
              await new Promise(resolve => setTimeout(resolve, 1));
            }
          };
          const measure = async (action, paint = false) => {
            __timings = [];
            const start = performance.now();
            await action();
            const commitMs = performance.now() - start;
            if (paint) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const ms = performance.now() - start, steps = __timings.map(step => ({ ...step }));
            // Union of crypto promise intervals, distinct from cumulative elapsed
            // times; neither value measures native crypto CPU execution alone.
            let cryptoBusyMs = 0, end = -Infinity;
            for (const step of steps.filter(s => s.start !== undefined).sort((a, b) => a.start - b.start)) {
              cryptoBusyMs += Math.max(0, step.end - Math.max(end, step.start)); end = Math.max(end, step.end);
            }
            return { ms, commitMs, cryptoBusyMs, itemRequests: steps.filter(step => step.items).length, steps };
          };
          await idle(); searchMetadataCache.clear();
          let prepared;
          const cold = await measure(async () => { prepared = await hydrateFileRecords(__perfRecords, { preserveOrder: true }); });
          const warm = await measure(async () => { prepared = await hydrateFileRecords(__perfRecords, { preserveOrder: true }); });
          if (prepared.some((file, i) => file.id !== i + 1 || file.name !== 'synthetic-' + String(i + 1).padStart(5, '0') + '.txt')) {
            throw new Error('Hydration changed record identity, order or metadata');
          }
          await navigateToFolder(8, 'Empty'); await idle(); searchMetadataCache.clear();
          const normal = await measure(async () => {
            if (!(await navigateToFolder(7, 'Files')).ok) throw new Error('Navigation failed');
          }, true);
          normal.loadedCount = __test.state.files.length;
          normal.scrollError = Math.abs(__test.appScrollPosition().y);
          await idle();
          // Prepare a previously visited full listing outside the timed interval.
          // Back retains metadata, but fetches fresh records and authenticates keys.
          prepared = await hydrateFileRecords(__perfRecords, { preserveOrder: true });
          __test.state.files = finalizeHydratedFiles(prepared);
          __test.state.itemLoadedFileIds = new Set(prepared.map(file => Number(file.id)));
          __test.state.itemNextFileOffset = null; __test.state.progressiveItemsLoading = false;
          __test.state.itemRenderLimit = count; __test.renderItems();
          const anchor = Math.min(90, count);
          document.querySelector('.file-card[data-file-id="' + anchor + '"]').scrollIntoView({ block: 'center' });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const position = __test.appScrollPosition().y;
          await navigateToFolder(8, 'Empty', { originType: 'file', originId: anchor }); await idle();
          const back = await measure(async () => {
            await new Promise(resolve => { addEventListener('popstate', resolve, { once: true }); history.back(); });
            await idle();
          }, true);
          back.loadedCount = __test.state.files.length;
          back.scrollError = Math.abs(position - __test.appScrollPosition().y);
          return { 'hydrate-cold': cold, 'hydrate-warm': warm, normal, back };
        }, { concurrency, count });
        const calls = (sample, name) => sample.steps.filter(step => step.name === name).length;
        for (const mode of modes) {
          const sample = measured[mode], expected = mode === 'normal' ? Math.min(32, count) : count;
          assert.equal(calls(sample, 'unlockFileKey'), expected, `${mode}: authenticate all envelopes`);
          assert.equal(calls(sample, 'decryptFileMetadata'), mode === 'back' || mode === 'hydrate-warm' ? 0 : expected, `${mode}: metadata cache behavior`);
          assert.ok(sample.steps.filter(step => step.name === 'mapperPeak').every(step => step.ms <= concurrency));
          if (mode === 'normal' || mode === 'back') {
            assert.equal(sample.loadedCount, expected);
            assert.ok(sample.scrollError <= 2, `${mode}: scroll error ${sample.scrollError}`);
            assert.ok(sample.itemRequests > 0, 'Warm metadata still requires fresh API records');
          }
          if (iteration >= 0) samples.get(concurrency)[mode].push({ ...sample, iteration, order: [...order] });
        }
      }
    }
    assert.deepEqual(errors, [], 'Browser errors');
    for (const concurrency of concurrencies) for (const mode of modes) {
      const values = samples.get(concurrency)[mode], steps = {};
      for (const name of ['api', 'readDisplayListingCache', 'hydrateFolderRecords', 'hydrateFileRecords', 'folderKey', 'mapperQueue', 'unlockFileKey', 'decryptFileMetadata', 'loadNextItemPage', 'ensureNavigationOriginRendered', 'renderItems', 'applyNavigationPosition']) {
        const sums = values.map(v => v.steps.filter(step => step.name === name).reduce((total, step) => total + step.ms, 0));
        steps[name] = { median: percentile(sums, .5), p95: percentile(sums, .95),
          calls: values.map(v => v.steps.filter(step => step.name === name).length) };
      }
      const result = { engine: engineName, browserVersion: browser.version(), device: mobile ? 'touch' : 'desktop', count, latency, cacheDelay, concurrency, maxResponseBytes, mode, n: repeats,
        median: percentile(values.map(v => v.ms), .5), p95: percentile(values.map(v => v.ms), .95),
        cryptoBusyMedian: percentile(values.map(v => v.cryptoBusyMs), .5), steps, samples: values };
      results.push(result);
      console.log('PERF', JSON.stringify({ ...result, samples: undefined }));
    }
    await page.close();
  } } finally { await browser.close(); }
} } finally {
  await fixture.close();
  if (process.env.TCLOUD_PERF_OUTPUT) {
    await mkdir(dirname(process.env.TCLOUD_PERF_OUTPUT), { recursive: true });
    await writeFile(process.env.TCLOUD_PERF_OUTPUT, JSON.stringify(results, null, 2));
  }
}
