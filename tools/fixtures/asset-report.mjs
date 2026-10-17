import { ALLOCATION_GROUPS } from '../../asset-report-k7m4q9x2/portfolio-model.mjs';

export function portfolioFixture() {
  return {
    schemaVersion: 1,
    period: '2024-01-06',
    basePrincipal: 1000,
    realizedProfit: { name: '架空の実現益', value: 50000 },
    performanceAdjustmentName: '架空の売却損調整',
    performanceAdjustmentSnapshots: [
      { effectiveFrom: '2024-01-03', cumulativeValue: -20 },
      { effectiveFrom: '2024-01-05', cumulativeValue: -30 }
    ],
    monthlyReport: { entries: [{ date: '2024-01', dateLabel: '2024年1月', text: '合成テスト用コメント' }] },
    history: [
      { period: '2024-01-02', basePrincipal: 1000, rawMarketValue: 2700 },
      { period: '2024-01-03', basePrincipal: 1000, rawMarketValue: 2750 },
      { period: '2024-01-06', basePrincipal: 1000, rawMarketValue: 2800 }
    ],
    assets: [
      { id: 'alpha', name: '架空銘柄A', category: '米株', costBasis: 1700, marketValue: 2000, color: '#ff8a61' },
      { id: 'beta', name: '架空銘柄B', category: '日本株', costBasis: 900, marketValue: 800, color: '#52e6aa' }
    ]
  };
}

export function syntheticPortfolio(historyCount, assetCount) {
  const data = portfolioFixture();
  data.basePrincipal = 6000000;
  data.assets = Array.from({ length: assetCount }, (_, index) => ({
    id: `synthetic-${index + 1}`, name: `合成銘柄${index + 1}`, category: ALLOCATION_GROUPS[index % 4].name,
    costBasis: 180000, marketValue: 200000 + index * 1000,
    color: ALLOCATION_GROUPS[index % 4].color
  }));
  const raw = data.assets.reduce((sum, asset) => sum + asset.marketValue, 0);
  data.history = Array.from({ length: historyCount }, (_, index) => ({
    period: new Date(Date.UTC(2018, 0, 1) + index * 86400000).toISOString().slice(0, 10),
    basePrincipal: data.basePrincipal,
    rawMarketValue: index === historyCount - 1 ? raw : raw + Math.round(Math.sin(index / 19) * 100000)
  }));
  data.period = data.history.at(-1).period;
  data.performanceAdjustmentSnapshots = [
    { effectiveFrom: '2018-01-10', cumulativeValue: -20000 },
    { effectiveFrom: '2018-02-01', cumulativeValue: -30000 }
  ];
  return data;
}
