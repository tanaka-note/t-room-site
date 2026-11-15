import { ALLOCATION_GROUPS, adjustedAllocationGroups, adjustmentForPeriod, isReportDate } from '../public/portfolio-model.mjs';
export class HttpError extends Error {
  constructor(status, message, code = 'invalid') { super(message); this.status = status; this.code = code; }
}
export function text(value, maximum, label = '入力') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, `${label}を確認してください。`);
  return value.trim();
}
export function amount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000) throw new HttpError(400, '金額は0以上の整数円で入力してください。');
  return value;
}
export function validateRecord(input, metadata) {
  if (!input || !isReportDate(input.period) || input.period < '1900-01-01' || input.period > '9999-12-31') throw new HttpError(400, '実在する更新日を指定してください。');
  const time = input.time === '' || input.time == null ? null : input.time;
  if (time !== null && (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new HttpError(400, '更新時刻を確認してください。');
  let assets = null, rawMarketValue;
  if (input.assets !== null) {
    if (!Array.isArray(input.assets) || input.assets.length < 1 || input.assets.length > 100) throw new HttpError(400, '銘柄は1〜100件で入力してください。');
    const ids = new Set();
    assets = input.assets.map(asset => {
      const id = text(asset.id, 80, '銘柄ID');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id)) throw new HttpError(400, '銘柄IDが不正または重複しています。');
      ids.add(id);
      const group = ALLOCATION_GROUPS.find(g => g.name === asset.category);
      if (!group) throw new HttpError(400, '資産分類を選択してください。');
      return { id, name: text(asset.name, 120, '銘柄名'), category: group.name, marketValue: amount(asset.marketValue), color: group.color };
    });
    rawMarketValue = amount(assets.reduce((sum, asset) => sum + asset.marketValue, 0));
    // Keep the existing dated four-category deduction, including its invariant.
    try { adjustedAllocationGroups({ ...metadata, period: input.period, assets }); }
    catch { throw new HttpError(400, '分類別評価額が既存の控除額を下回っています。分類と金額を確認してください。'); }
  } else rawMarketValue = amount(input.rawMarketValue);
  if (rawMarketValue + adjustmentForPeriod(metadata.performanceAdjustmentSnapshots, input.period) < 0) throw new HttpError(400, '合計額が控除額を下回っています。');
  return { period: input.period, time, rawMarketValue, assets };
}
export function storedRecord(row) {
  return { period: row.period, time: row.time, rawMarketValue: row.raw_market_value, assets: row.assets === null ? null : JSON.parse(row.assets) };
}
export function reportView(metadata, history, record) {
  const adjustment = adjustmentForPeriod(metadata.performanceAdjustmentSnapshots, record.period);
  const marketValue = record.rawMarketValue + adjustment, profit = marketValue - metadata.basePrincipal;
  return { ...metadata, ...record, assets: record.assets || [], hasBreakdown: record.assets !== null, history,
    summary: { rawMarketValue: record.rawMarketValue, adjustment, marketValue, profit, returnRate: profit / metadata.basePrincipal * 100 } };
}
