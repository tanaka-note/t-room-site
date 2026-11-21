import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import legacy from '../../asset-report-k7m4q9x2/data/portfolio-data.mjs';
import imported from '../seed/report.mjs';
import * as legacyModel from '../../asset-report-k7m4q9x2/portfolio-model.mjs';
import * as dynamicModel from '../public/portfolio-model.mjs';
import { seedStatements } from '../tools/seed.mjs';
import { validateRecord, reportView } from '../src/domain.js';

const read = relativePath => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const latestAssetsWithoutCost = legacy.assets.map(({ costBasis, ...asset }) => asset);

test('legacy and dynamic source contain precisely the same 75 historical dates and 11 latest holdings', () => {
  assert.deepEqual(imported, legacy, 'import must equal the frozen legacy source, not a hand-copied approximation');
  assert.equal(legacy.history.length, 75);
  assert.equal(legacy.assets.length, 11);
  assert.equal(legacy.period, '2026-10-31');
  assert.equal(legacy.history.at(-1).period, legacy.period);
  assert.equal(legacy.history.at(-1).rawMarketValue, legacy.assets.reduce((total, asset) => total + asset.marketValue, 0));
  assert.equal(legacy.history[0].period, '2026-07-31');
});

test('real imported data seeds all dated D1 records exactly without inventing earlier stock-level values', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(read('../migrations/0001_portfolio.sql'));
    const statements = seedStatements();
    for (const statement of statements) sqlite.prepare(statement.sql).run(...statement.params);
    const rows = sqlite.prepare('SELECT period,time,raw_market_value,assets FROM portfolio_records ORDER BY period').all();
    assert.equal(rows.length, 75);
    assert.deepEqual(rows.map(row => ({ period: row.period, rawMarketValue: row.raw_market_value })), legacy.history.map(row => ({ period: row.period, rawMarketValue: row.rawMarketValue })));
    assert.ok(rows.slice(0, -1).every(row => row.assets === null), 'historical records must remain total-only');
    assert.equal(rows.at(-1).time, null);
    assert.deepEqual(JSON.parse(rows.at(-1).assets), latestAssetsWithoutCost);
    const state = sqlite.prepare("SELECT revision,metadata FROM portfolio_state WHERE id='main'").get();
    const { history, assets, ...expectedMetadata } = legacy;
    assert.equal(state.revision, 0);
    assert.deepEqual(JSON.parse(state.metadata), expectedMetadata);
    assert.deepEqual(sqlite.prepare('SELECT id,role FROM portfolio_accounts ORDER BY id').all().map(({ id, role }) => ({ id, role })), [
      { id: 'owner', role: 'owner' }, { id: 'viewer', role: 'viewer' }
    ]);
  } finally {
    sqlite.close();
  }
});

test('all historical totals, dated deductions, category allocation and current performance match legacy calculation', () => {
  const oldCalculation = legacyModel.createPortfolioModel(legacy);
  const newCalculation = dynamicModel.createPortfolioModel(imported);
  for (const history of legacy.history) {
    assert.equal(newCalculation.historyMarketValue(history), oldCalculation.historyMarketValue(history), history.period);
  }
  assert.deepEqual(newCalculation.summary(), oldCalculation.summary());
  assert.deepEqual(dynamicModel.adjustedAllocationGroups(imported), legacyModel.adjustedAllocationGroups(legacy));
  assert.equal(dynamicModel.adjustedAllocationGroups(imported).reduce((sum, row) => sum + row.marketValue, 0), newCalculation.summary().marketValue);
  assert.equal(newCalculation.adjustmentForPeriod('2026-08-14'), 0);
  assert.equal(newCalculation.adjustmentForPeriod('2026-08-15'), -220000);
  assert.equal(newCalculation.adjustmentForPeriod('2026-09-13'), -320000);
  assert.equal(newCalculation.summary().rawMarketValue, 6418416);
  assert.equal(newCalculation.summary().marketValue, 6098416);
  assert.equal(newCalculation.summary().profit, 98416);
  assert.ok(Math.abs(newCalculation.summary().returnRate - 1.6402666666666667) < 1e-9);
});

test('new API record preserves the legacy latest summary and honors the dynamic source after saving', () => {
  const { history, assets, ...metadata } = imported;
  const result = validateRecord({
    period: imported.period,
    time: null,
    assets: latestAssetsWithoutCost,
    rawMarketValue: 0
  }, metadata);
  assert.equal(result.rawMarketValue, 6418416);
  const view = reportView(metadata, history, result);
  assert.equal(view.hasBreakdown, true);
  assert.equal(view.summary.marketValue, 6098416);
  assert.equal(view.summary.profit, 98416);
  assert.deepEqual(view.assets, latestAssetsWithoutCost);
  assert.deepEqual(view.history, legacy.history);
});

test('dynamic display retains the actual legacy chart, sections and styling without embedding financial data in the public shell', () => {
  const oldCss = read('../../asset-report-k7m4q9x2/report.css');
  const newCss = read('../public/report.css');
  assert.equal(newCss, oldCss, 'portfolio display CSS should remain byte-for-byte identical');
  const oldHtml = read('../../asset-report-k7m4q9x2/index.html');
  const newHtml = read('../public/index.html');
  const selectors = ['principal-value', 'market-value', 'profit-value', 'return-value',
    'history-section', 'history-range-controls', 'history-chart', 'history-tooltip',
    'allocation-chart', 'allocation-legend', 'donut-total', 'holdings-body',
    'monthly-report-entries', 'report-updated'];
  for (const id of selectors) {
    assert.ok(oldHtml.includes('id="' + id + '"'), 'missing baseline UI: ' + id);
    assert.ok(newHtml.includes('id="' + id + '"'), 'dynamic UI omitted: ' + id);
  }
  assert.match(newHtml, /<meta name="robots" content="noindex/);
  assert.match(newHtml, /<main id="report-app" class="report-shell" hidden>/);
  assert.doesNotMatch(newHtml, /portfolio-data\.mjs|2037294|1969928/, 'public shell must not expose holdings');
  assert.match(newHtml, /<th scope="col">銘柄名<\/th>/);
  assert.match(newHtml, /<th scope="col">時価総額<\/th>/);
});
