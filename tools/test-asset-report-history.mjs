import assert from 'node:assert/strict';
import test from 'node:test';
import { portfolioFixture } from './fixtures/asset-report.mjs';
import { ALLOCATION_GROUPS, allocationGroups, adjustedAllocationGroups, adjustmentForPeriod, assetProfit, assetReturnRate, calculateHistoryScale, createPortfolioModel, validatePortfolioData } from '../asset-report-k7m4q9x2/portfolio-model.mjs';

test('adjusted allocation tracks prices and the latest cumulative deduction with exact yen totals', () => {
  const data = portfolioFixture();
  data.assets = ALLOCATION_GROUPS.map((group, index) => ({ id: group.id, name: group.name, category: group.name, color: group.color, costBasis: 1000000, marketValue: 1000000 + index * 100000 }));
  data.history.at(-1).rawMarketValue = 4600000;
  data.performanceAdjustmentSnapshots.push({ effectiveFrom: '2024-01-06', cumulativeValue: -320000 });
  const unchanged = structuredClone(data);
  const groups = adjustedAllocationGroups(data);
  assert.deepEqual(groups.map(group => group.marketValue), [920000, 1020000, 1120000, 1220000]);
  assert.deepEqual(groups.map(group => group.adjustment), [-80000, -80000, -80000, -80000]);
  assert.deepEqual(groups.map(group => group.rawMarketValue), [1000000, 1100000, 1200000, 1300000]);
  assert.deepEqual(data, unchanged, 'allocation must never change raw data/history');
  data.performanceAdjustmentSnapshots.push({ effectiveFrom: '2024-01-07', cumulativeValue: -400003 });
  assert.deepEqual(adjustedAllocationGroups(data), groups, 'future deduction does not affect today');
  data.period = '2024-01-07';
  assert.deepEqual(adjustedAllocationGroups(data).map(group => group.adjustment), [-100001, -100001, -100001, -100000]);
  data.assets[1].marketValue += 12345;
  const changed = adjustedAllocationGroups(data);
  assert.equal(changed[1].marketValue, 1100000 + 12345 - 100001, 'daily prices automatically feed adjusted allocation');
  data.assets.reverse(); data.assets[0].name = '名称変更'; data.realizedProfit.value *= 10;
  assert.deepEqual(adjustedAllocationGroups(data), changed, 'name/order/realized profit do not change allocation');
  data.period = '2024-01-08';
  data.performanceAdjustmentSnapshots.push({ effectiveFrom: data.period, cumulativeValue: -200001 });
  assert.deepEqual(adjustedAllocationGroups(data).map(group => group.adjustment), [-50001, -50000, -50000, -50000], 'lower cumulative deduction replaces the earlier amount');
  for (const [deduction, expected] of [[0, [0, 0, 0, 0]], [1, [-1, 0, 0, 0]], [2, [-1, -1, 0, 0]], [3, [-1, -1, -1, 0]], [4, [-1, -1, -1, -1]], [31, [-8, -8, -8, -7]]]) {
    data.performanceAdjustmentSnapshots.at(-1).cumulativeValue = -deduction;
    const result = adjustedAllocationGroups(data);
    assert.deepEqual(result.map(group => group.adjustment), expected);
    assert.equal(result.reduce((sum, group) => sum + group.marketValue, 0), createPortfolioModel(data).summary().marketValue);
    assert.ok(result.every(group => Number.isSafeInteger(group.marketValue)));
  }
  data.performanceAdjustmentSnapshots = [];
  assert.deepEqual(adjustedAllocationGroups(data).map(group => group.marketValue), allocationGroups(data).map(group => group.marketValue));
});

test('allocation combines assets into four stable groups without changing performance', () => {
  const data = portfolioFixture();
  data.assets.push(
    { ...data.assets[1], id: 'gamma', name: '別の日本株', marketValue: 200 },
    { ...data.assets[0], id: 'delta', category: 'インド株', color: '#f4ca64', marketValue: 300 },
    { ...data.assets[0], id: 'epsilon', category: 'ビットコイン', color: '#a98cff', marketValue: 400 }
  );
  const summary = createPortfolioModel(data).summary();
  const groups = allocationGroups(data);
  assert.deepEqual(groups.map(({ name, color, marketValue }) => ({ name, color, marketValue })), [
    { name: '米株', color: '#ff8a61', marketValue: 2000 },
    { name: 'インド株', color: '#f4ca64', marketValue: 300 },
    { name: 'ビットコイン', color: '#a98cff', marketValue: 400 },
    { name: '日本株', color: '#52e6aa', marketValue: 1000 }
  ]);
  assert.equal(groups.reduce((sum, group) => sum + group.marketValue, 0), summary.rawMarketValue);
  data.assets.reverse(); data.assets[0].name = '名称変更';
  assert.deepEqual(allocationGroups(data), groups, 'names and order do not affect classification');
  assert.deepEqual(createPortfolioModel(data).summary(), summary);
  for (const asset of data.assets) asset.marketValue = 0;
  assert.deepEqual(allocationGroups(data).map(group => group.marketValue), [0, 0, 0, 0]);
  assert.equal(new Set(ALLOCATION_GROUPS.map(group => group.color)).size, 4);
  data.assets[0].category = '未分類';
  assert.throws(() => allocationGroups(data), /unknown allocation group/);
});

test('dated cumulative adjustment replaces earlier loss, including exact boundary dates', () => {
  const { performanceAdjustmentSnapshots: snapshots } = portfolioFixture();
  for (const [date, expected] of [['2024-01-02', 0], ['2024-01-03', -20], ['2024-01-04', -20], ['2024-01-05', -30], ['2024-01-06', -30]]) {
    assert.equal(adjustmentForPeriod(snapshots, date), expected);
  }
  assert.equal(adjustmentForPeriod([], '2024-01-06'), 0);
});

test('future adjustment never rewrites earlier history or the current summary', () => {
  const data = portfolioFixture();
  const model = createPortfolioModel(data);
  const rawHistory = structuredClone(data.history);
  const displayed = data.history.map(model.historyMarketValue);
  const summary = model.summary();
  data.performanceAdjustmentSnapshots.push({ effectiveFrom: '2024-01-07', cumulativeValue: -80 });
  assert.deepEqual(data.history.map(model.historyMarketValue), displayed);
  assert.deepEqual(data.history, rawHistory);
  assert.deepEqual(model.summary(), summary);
  assert.equal(model.adjustmentForPeriod('2024-01-07'), -80);
});

test('raw allocation, adjusted performance and acquisition cost are separate concepts', () => {
  const data = portfolioFixture();
  validatePortfolioData(data, { expectedBasePrincipal: 1000 });
  const model = createPortfolioModel(data);
  assert.deepEqual(model.summary(), { rawMarketValue: 2800, adjustment: -30, marketValue: 2770, profit: 1770, returnRate: 177 });
  assert.equal(data.assets.reduce((sum, asset) => sum + asset.costBasis, 0), 2600);
  assert.equal(assetProfit(data.assets[0]), 300);
  assert.equal(assetReturnRate(data.assets[0]), 300 / 1700 * 100);
  assert.equal(assetProfit(data.assets[1]), -100);
  assert.equal(data.assets[0].marketValue / model.summary().rawMarketValue, 2000 / 2800);
  data.realizedProfit.value *= 10;
  assert.equal(model.summary().marketValue, 2770, 'display-only realized profit is never added');
  assert.deepEqual(data.history.map(model.historyMarketValue), [2700, 2730, 2770]);
  data.assets[0].name = '変更後の表示名';
  assert.equal(data.assets[0].id, 'alpha');
  assert.equal(model.summary().marketValue, 2770);
});

test('history scale preserves small variations, large ranges and empty/nonfinite input behavior', () => {
  const small = calculateHistoryScale([6380000, 6400000, 6420000, 6390000, 6410000]);
  assert.equal(small.minValue, 6380000);
  assert.equal(small.maxValue, 6420000);
  assert.equal(small.adjustedSpread, 160500);
  assert.ok(small.ySpan < 300000);
  const large = calculateHistoryScale([6000000, 8000000]);
  assert.ok(large.yMin <= 6000000 && large.yMax >= 8000000);
  for (const values of [[], [NaN, Infinity]]) assert.equal(calculateHistoryScale(values).ySpan, 1);
});
