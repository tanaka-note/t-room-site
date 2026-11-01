import source from '../seed/report.mjs';
import { validatePortfolioData } from '../public/portfolio-model.mjs';
validatePortfolioData(source);
export function seedStatements(data = source) {
  const { history, assets, ...metadata } = data;
  return [
    { sql: "INSERT INTO portfolio_state(id,revision,metadata) VALUES('main',0,?) ON CONFLICT(id) DO NOTHING", params: [JSON.stringify(metadata)] },
    ...history.map(entry => ({ sql: 'INSERT INTO portfolio_records(period,time,raw_market_value,assets,updated_at,updated_by) VALUES(?,NULL,?,?,?,?) ON CONFLICT(period) DO NOTHING', params: [entry.period, entry.rawMarketValue, entry.period === data.period ? JSON.stringify(assets.map(({ costBasis, ...asset }) => asset)) : null, new Date().toISOString(), 'legacy-import'] }))
  ];
}
