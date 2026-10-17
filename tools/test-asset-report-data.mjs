import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { portfolioFixture } from './fixtures/asset-report.mjs';
import data from '../asset-report-k7m4q9x2/data/portfolio-data.mjs';
import { BASE_PRINCIPAL, validatePortfolioData } from '../asset-report-k7m4q9x2/portfolio-model.mjs';
import { collectEntrypointShellAssets, ensureHtmlContract, inspectBuildFreshness, loadWebAppRegistry, workspace } from './web-app-registry.mjs';
import { resolve } from 'node:path';

test('current data preserves reference principal and agrees with the single HTML update date', async () => {
  validatePortfolioData(data);
  assert.equal(data.basePrincipal, BASE_PRINCIPAL);
  const html = await readFile(resolve(workspace, 'asset-report-k7m4q9x2/index.html'), 'utf8');
  const dates = [...html.matchAll(/<time id="report-updated" datetime="([^"]+)">([^<]+)<\/time>/g)];
  assert.equal(dates.length, 1);
  assert.equal(dates[0][1], data.period);
  assert.equal(dates[0][2], data.period.replaceAll('-', '.'));
  assert.match(html, /<script type="module" src="\.\/report\.js\?v=/);
});

test('data/model modules participate in the existing content hash and PWA precache', async () => {
  const registry = await loadWebAppRegistry();
  const app = registry.apps.find(app => app.id === 'asset-report');
  const freshness = await inspectBuildFreshness(app, registry.contract);
  assert.equal(freshness.fresh, true, JSON.stringify(freshness.issues));
  const assets = await collectEntrypointShellAssets(app, registry.contract, freshness.expected);
  for (const path of ['data/portfolio-data.mjs', 'portfolio-model.mjs']) assert.ok(assets.includes(`/asset-report-k7m4q9x2/${path}?v=${freshness.expected}`), path);
});

test('modulepreload versioning leaves unrelated existing module scripts unchanged', async () => {
  const registry = await loadWebAppRegistry();
  const app = registry.apps.find(app => app.id === 'asset-report');
  const html = '<html><head><link rel="modulepreload" href="./data/new.mjs"></head><body><script type="module" src="./existing.mjs"></script></body></html>';
  const synced = ensureHtmlContract(html, app, registry.contract, 'asset-report-111111111111');
  assert.ok(synced.includes('./data/new.mjs?v=asset-report-111111111111'));
  assert.ok(synced.includes('<script type="module" src="./existing.mjs"></script>'));
});

test('inconsistent data fails instead of being silently omitted from the report', () => {
  const invalid = [
    ['calendar date', d => { d.period = '2024-02-30'; }],
    ['date format', d => { d.period = '2024-1-06'; }],
    ['unsorted history', d => { d.history.reverse(); }],
    ['duplicate history', d => { d.history[1].period = d.history[0].period; }],
    ['latest date', d => { d.period = '2024-01-07'; }],
    ['raw total', d => { d.history.at(-1).rawMarketValue++; }],
    ['duplicate asset ID', d => { d.assets[1].id = d.assets[0].id; }],
    ['duplicate adjustment', d => { d.performanceAdjustmentSnapshots[1].effectiveFrom = d.performanceAdjustmentSnapshots[0].effectiveFrom; }],
    ['unsorted adjustments', d => { d.performanceAdjustmentSnapshots.reverse(); }],
    ['positive loss', d => { d.performanceAdjustmentSnapshots[0].cumulativeValue = 100; }],
    ['reference principal', d => { d.basePrincipal++; }],
    ['historical principal', d => { d.history[0].basePrincipal++; }],
    ['zero cost basis', d => { d.assets[0].costBasis = 0; }],
    ['invalid color', d => { d.assets[0].color = 'not-a-color'; }],
    ['empty assets', d => { d.assets = []; }],
    ['empty history', d => { d.history = []; }],
    ['ambiguous legacy field', d => { d.principal = 1000; }]
  ];
  for (const value of [NaN, Infinity, null, '100', 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) invalid.push([`invalid amount ${String(value)}`, d => { d.assets[0].marketValue = value; }]);
  for (const value of [NaN, Infinity, null, '100']) {
    for (const mutate of [
      d => { d.basePrincipal = value; }, d => { d.assets[0].costBasis = value; },
      d => { d.history[0].basePrincipal = value; }, d => { d.history[0].rawMarketValue = value; },
      d => { d.realizedProfit.value = value; }, d => { d.performanceAdjustmentSnapshots[0].cumulativeValue = value; }
    ]) invalid.push([`non-numeric field ${String(value)}`, mutate]);
  }
  for (const [name, change] of invalid) {
    const d = portfolioFixture(); change(d);
    assert.throws(() => validatePortfolioData(d, { expectedBasePrincipal: 1000 }), name);
  }
});
