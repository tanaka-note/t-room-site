import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import data from '../asset-report-k7m4q9x2/data/portfolio-data.mjs';
import { createPortfolioModel, validatePortfolioData } from '../asset-report-k7m4q9x2/portfolio-model.mjs';
import { syntheticPortfolio } from './fixtures/asset-report.mjs';

const root = resolve(import.meta.dirname, '..');
const { chromium } = createRequire(new URL('../diary-worker/package.json', import.meta.url))('playwright');
const server = createServer(async (request, response) => {
  try {
    let path = new URL(request.url, 'http://fixture').pathname;
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const yen = value => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);
const browser = await chromium.launch({ headless: true });
const results = [];

async function inspect(page, portfolio) {
  const model = createPortfolioModel(portfolio);
  await page.waitForFunction(() => document.querySelectorAll('#holdings-body tr[data-asset-id]').length > 0);
  assert.equal(await page.locator('#market-value').textContent(), yen(model.summary().marketValue));
  assert.equal(await page.locator('#donut-total').textContent(), yen(model.summary().marketValue));
  assert.equal(await page.locator('#report-updated').getAttribute('datetime'), portfolio.period);
  assert.equal(await page.locator('#holdings-body tr[data-asset-id]').count(), portfolio.assets.length);
  assert.equal(await page.locator('#holdings-body tr').count(), portfolio.assets.length + 2);
  for (const asset of portfolio.assets) {
    const row = page.locator(`#holdings-body tr[data-asset-id="${asset.id}"]`);
    assert.equal(await row.locator('td').nth(1).textContent(), yen(asset.marketValue));
    const legend = page.locator(`#allocation-legend li[data-asset-id="${asset.id}"]`);
    assert.equal(await legend.locator('.legend-share').textContent(), `${(asset.marketValue / model.summary().rawMarketValue * 100).toFixed(2)}%`);
  }
  assert.equal(await page.locator('#history-section').isVisible(), true);
  const entries = portfolio.monthlyReport.entries.filter(entry => entry.text.trim()).sort((a, b) => b.date.localeCompare(a.date));
  assert.equal(await page.locator('#comment-section').isVisible(), entries.length > 0);
  assert.equal(await page.locator('#comment-title').textContent(), 'レポート（不定期）');
  assert.equal(await page.locator('#monthly-report-entries section').count(), entries.length);
  for (const [index, entry] of entries.entries()) {
    const article = page.locator('#monthly-report-entries section').nth(index);
    assert.equal(await article.locator('time').getAttribute('datetime'), entry.date);
    assert.equal(await article.locator('time').textContent(), entry.dateLabel);
    assert.equal(await article.locator('p').textContent(), entry.text);
  }
  for (const [range, days] of [['7d', 7], ['1m', 31], ['all', null]]) {
    await page.locator(`button[data-history-range="${range}"]`).click();
    assert.equal(await page.locator(`button[data-history-range="${range}"]`).getAttribute('aria-pressed'), 'true');
    const cutoff = days ? new Date(Date.parse(portfolio.period) - days * 86400000).toISOString().slice(0, 10) : '';
    const first = portfolio.history.find(entry => entry.period >= cutoff);
    const firstLabel = first.period.replaceAll('-', '.');
    const lastLabel = portfolio.period.replaceAll('-', '.');
    assert.equal(await page.locator('#history-period').textContent(), `${firstLabel} — ${lastLabel}`);
    const box = await page.locator('#history-chart').boundingBox();
    await page.locator('#history-chart').dispatchEvent('pointerdown', { clientX: box.x + box.width - 1, clientY: box.y + 100, pointerType: 'touch' });
    assert.equal(await page.locator('#history-tooltip time').getAttribute('datetime'), portfolio.period);
    assert.equal(await page.locator('#history-tooltip strong').textContent(), yen(model.historyMarketValue(portfolio.history.at(-1))));
  }
  const geometry = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    historyNodes: document.querySelector('#history-section').querySelectorAll('*').length,
    painted: ['history-chart', 'allocation-chart'].every(id => {
      const canvas = document.getElementById(id);
      return canvas.width > 0 && canvas.height > 0 && canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
    })
  }));
  assert.ok(geometry.overflow <= 1, `horizontal document overflow: ${geometry.overflow}`);
  assert.equal(geometry.painted, true);
  return geometry;
}

try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, timezoneId: 'Asia/Tokyo' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(`${origin}/asset-report-k7m4q9x2/`);
    results.push({ width, kind: 'current', ...await inspect(page, data) });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const cachedModules = await page.evaluate(async () => {
      const entries = await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(request => request.url)));
      return entries.flat();
    });
    for (const path of ['data/portfolio-data.mjs', 'portfolio-model.mjs']) assert.ok(cachedModules.some(url => url.includes(path + '?v=')), path);
    await context.setOffline(true);
    await page.reload();
    await inspect(page, data);
    assert.deepEqual(errors, [], 'online/offline runtime must be error-free');
    results.push({ width, kind: 'offline', modulesPrecached: true });
    await context.close();
  }
  let expectedHistoryNodes;
  for (const [historyCount, assetCount] of [[300, 20], [1000, 25], [3000, 30]]) {
    const synthetic = syntheticPortfolio(historyCount, assetCount);
    validatePortfolioData(synthetic);
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, serviceWorkers: 'block', timezoneId: 'Asia/Tokyo' });
      const page = await context.newPage(); const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (!url.startsWith(origin)) return route.abort();
        if (new URL(url).pathname.endsWith('/data/portfolio-data.mjs')) return route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(synthetic)};` });
        return route.continue();
      });
      await page.goto(`${origin}/asset-report-k7m4q9x2/`);
      const geometry = await inspect(page, synthetic);
      expectedHistoryNodes ??= geometry.historyNodes;
      assert.equal(geometry.historyNodes, expectedHistoryNodes, 'history length must not grow DOM nodes');
      const elapsed = await page.evaluate(() => {
        const canvas = document.getElementById('history-chart'), box = canvas.getBoundingClientRect();
        const start = performance.now();
        for (let index = 0; index < 60; index++) canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + box.width * index / 59, clientY: box.top + 100 }));
        return Math.round(performance.now() - start);
      });
      assert.deepEqual(errors, []);
      results.push({ width, historyCount, assetCount, pointerMoves60Ms: elapsed, ...geometry });
      await context.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
